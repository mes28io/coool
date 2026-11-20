//! The connection to the relay (Convex): one WebSocket through the official `convex` client, on a thread of its
//! own with a small Tokio runtime. The rest of the Mac side is synchronous: [`Transport::mutation`] blocks for the
//! answer, and a live query's answers arrive on a std channel.

use anyhow::{Result, anyhow, bail};
use convex::{ConvexClient, FunctionResult, Value};
use futures::StreamExt;
use serde_json::Value as Json;
use std::collections::BTreeMap;
use std::sync::mpsc as smpsc;
use std::time::Duration;
use tokio::sync::mpsc;

enum Req {
    Mutation(String, Json, smpsc::Sender<Result<Json>>),
    Query(String, Json, smpsc::Sender<Result<Json>>),
    Subscribe(String, Json, smpsc::Sender<Result<Json>>),
    Unsubscribe,
}

/// A handle on the relay thread; dropping every handle ends it.
#[derive(Clone)]
pub struct Transport {
    tx: mpsc::UnboundedSender<Req>,
}

const CALL_TIMEOUT: Duration = Duration::from_secs(20);

fn args_of(j: Json) -> Result<BTreeMap<String, Value>> {
    match Value::try_from(j)? {
        Value::Object(m) => Ok(m),
        _ => bail!("arguments must be an object"),
    }
}

fn json_of(r: FunctionResult) -> Result<Json> {
    match r {
        FunctionResult::Value(v) => Ok(v.export()),
        FunctionResult::ErrorMessage(m) => Err(anyhow!("relay error: {m}")),
        FunctionResult::ConvexError(e) => Err(anyhow!("relay error: {}", e.message)),
    }
}

impl Transport {
    pub fn start(url: &str) -> Result<Transport> {
        if !url.starts_with("https://") {
            bail!("the relay address must be https://");
        }
        let (tx, mut rx) = mpsc::unbounded_channel::<Req>();
        let (ready_tx, ready_rx) = smpsc::channel::<Result<()>>();
        let url = url.to_string();
        std::thread::Builder::new()
            .name("coool-remote-relay".into())
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.into()));
                        return;
                    }
                };
                rt.block_on(async move {
                    let client = match tokio::time::timeout(CALL_TIMEOUT, ConvexClient::new(&url)).await {
                        Ok(Ok(c)) => c,
                        Ok(Err(e)) => {
                            let _ = ready_tx.send(Err(e));
                            return;
                        }
                        Err(_) => {
                            let _ = ready_tx.send(Err(anyhow!("the relay did not answer")));
                            return;
                        }
                    };
                    let _ = ready_tx.send(Ok(()));
                    let mut live: Option<tokio::task::JoinHandle<()>> = None;
                    while let Some(req) = rx.recv().await {
                        match req {
                            Req::Mutation(name, args, reply) => {
                                let mut c = client.clone();
                                tokio::spawn(async move {
                                    let r = async {
                                        let a = args_of(args)?;
                                        match tokio::time::timeout(CALL_TIMEOUT, c.mutation(&name, a)).await {
                                            Ok(r) => json_of(r?),
                                            Err(_) => Err(anyhow!("the relay did not answer")),
                                        }
                                    }
                                    .await;
                                    let _ = reply.send(r);
                                });
                            }
                            Req::Query(name, args, reply) => {
                                let mut c = client.clone();
                                tokio::spawn(async move {
                                    let r = async {
                                        let a = args_of(args)?;
                                        match tokio::time::timeout(CALL_TIMEOUT, c.query(&name, a)).await {
                                            Ok(r) => json_of(r?),
                                            Err(_) => Err(anyhow!("the relay did not answer")),
                                        }
                                    }
                                    .await;
                                    let _ = reply.send(r);
                                });
                            }
                            Req::Subscribe(name, args, updates) => {
                                if let Some(h) = live.take() {
                                    h.abort();
                                }
                                let mut c = client.clone();
                                live = Some(tokio::spawn(async move {
                                    let sub = match args_of(args) {
                                        Ok(a) => c.subscribe(&name, a).await,
                                        Err(e) => Err(e),
                                    };
                                    let mut sub = match sub {
                                        Ok(s) => s,
                                        Err(e) => {
                                            let _ = updates.send(Err(e));
                                            return;
                                        }
                                    };
                                    while let Some(r) = sub.next().await {
                                        if updates.send(json_of(r)).is_err() {
                                            return;
                                        }
                                    }
                                }));
                            }
                            Req::Unsubscribe => {
                                if let Some(h) = live.take() {
                                    h.abort();
                                }
                            }
                        }
                    }
                    if let Some(h) = live.take() {
                        h.abort();
                    }
                });
            })?;
        ready_rx.recv_timeout(CALL_TIMEOUT + Duration::from_secs(2)).map_err(|_| anyhow!("the relay did not answer"))??;
        Ok(Transport { tx })
    }

    fn call(&self, make: impl FnOnce(smpsc::Sender<Result<Json>>) -> Req) -> Result<Json> {
        let (tx, rx) = smpsc::channel();
        self.tx.send(make(tx)).map_err(|_| anyhow!("the relay connection is closed"))?;
        rx.recv_timeout(CALL_TIMEOUT + Duration::from_secs(2)).map_err(|_| anyhow!("the relay did not answer"))?
    }

    /// `relay:<name>`; returns the function's value (`{ok, ...}`).
    pub fn mutation(&self, name: &str, args: Json) -> Result<Json> {
        self.call(|tx| Req::Mutation(format!("relay:{name}"), args, tx))
    }

    pub fn query(&self, name: &str, args: Json) -> Result<Json> {
        self.call(|tx| Req::Query(format!("relay:{name}"), args, tx))
    }

    /// Replaces the one live query: each new answer of `relay:<name>` arrives on `updates`.
    pub fn subscribe(&self, name: &str, args: Json, updates: smpsc::Sender<Result<Json>>) -> Result<()> {
        self.tx.send(Req::Subscribe(format!("relay:{name}"), args, updates)).map_err(|_| anyhow!("the relay connection is closed"))
    }

    pub fn unsubscribe(&self) {
        let _ = self.tx.send(Req::Unsubscribe);
    }
}
