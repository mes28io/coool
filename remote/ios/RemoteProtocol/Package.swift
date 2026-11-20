// swift-tools-version: 5.10
// coool Remote's protocol, the phone's side (docs/REMOTE.md): keys, pairing, message sealing, relay request
// signatures, the inbox. CryptoKit only; no UI, no network.

import PackageDescription

let package = Package(
  name: "RemoteProtocol",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [.library(name: "RemoteProtocol", targets: ["RemoteProtocol"])],
  targets: [
    .target(name: "RemoteProtocol"),
    .testTarget(name: "RemoteProtocolTests", dependencies: ["RemoteProtocol"]),
  ]
)
