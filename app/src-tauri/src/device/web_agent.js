// The page side of the coool-device browser tools (device/web.rs). Rust runs `(<this function>)(<command JSON>)` in a
// WKContentWorld of its own ("coool-agent"), so the page's scripts can't see these globals or patch the prototypes
// used here. Every call returns a JSON string: {"ok": result} or {"error": message}.
//
// Rules: read the DOM, never storage. Nothing here touches cookies, web storage or IndexedDB, and the value of a
// password field (or a card number / one-time code) never leaves the page: observe says only whether it is filled.
// Ids are per document: an element keeps its id while it stays on the page; a new document starts over with a new
// `doc` token, and Rust refuses ids from an older document.
(function (cmd) {
  "use strict";
  var g = globalThis;
  var A = g.__cooolAgent;
  if (!A) A = g.__cooolAgent = makeAgent();
  var out;
  try {
    out = { ok: A.run(cmd || {}) };
  } catch (e) {
    out = { error: String((e && e.message) || e) };
  }
  return JSON.stringify(out);

  function makeAgent() {
    var ids = new WeakMap(); // element -> id
    var byId = new Map(); // id -> WeakRef(element)
    var next = 1;
    var DOC = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    var ours = new WeakSet(); // the click highlight (left out of snapshots and of the idle signal)
    var lastMutation = Date.now();
    var mutations = 0;
    var now = function () {
      return Date.now();
    };

    var ROLES = {
      button: 1, link: 1, checkbox: 1, radio: 1, switch: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1,
      menuitemradio: 1, option: 1, combobox: 1, textbox: 1, searchbox: 1, slider: 1, spinbutton: 1, treeitem: 1,
      heading: 1, listbox: 1,
    };
    var INPUT_ROLES = {
      checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
      button: "button", submit: "button", reset: "button", image: "button", file: "file", color: "color",
    };
    var SKIP = { script: 1, style: 1, noscript: 1, template: 1, head: 1, meta: 1, link: 1, title: 1 };
    var TEXT_TYPES = {
      text: 1, search: 1, email: 1, url: 1, tel: 1, password: 1, number: 1, date: 1, "datetime-local": 1, month: 1,
      week: 1, time: 1, color: 1, range: 1,
    };

    // Watch the page for the "settled" signal (after an action: no DOM change for a while).
    try {
      new MutationObserver(function (recs) {
        for (var i = 0; i < recs.length; i++) {
          if (!isOurs(recs[i])) {
            lastMutation = now();
            mutations++;
            return;
          }
        }
      }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) {}

    function isOurs(r) {
      if (ours.has(r.target)) return true;
      if (r.type !== "childList") return false;
      var all = r.addedNodes.length + r.removedNodes.length > 0;
      for (var i = 0; i < r.addedNodes.length; i++) if (!ours.has(r.addedNodes[i])) all = false;
      for (var j = 0; j < r.removedNodes.length; j++) if (!ours.has(r.removedNodes[j])) all = false;
      return all;
    }

    function norm(s) {
      return String(s == null ? "" : s).replace(/[\s ​]+/g, " ").trim();
    }
    function cut(s, n) {
      s = norm(s);
      return s.length > n ? s.slice(0, n - 1) + "…" : s;
    }
    function tagOf(el) {
      return String(el.localName || el.tagName || "").toLowerCase();
    }
    function attr(el, a) {
      return el.getAttribute ? el.getAttribute(a) : null;
    }
    function inputType(el) {
      return String(el.type || attr(el, "type") || "text").toLowerCase();
    }
    /** A field whose value must never leave the page. */
    function secret(el) {
      if (tagOf(el) !== "input") return false;
      if (inputType(el) === "password") return true;
      var ac = String(attr(el, "autocomplete") || "").toLowerCase();
      return /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc)(\s|$)/.test(ac);
    }
    function textOf(el) {
      var t = el.innerText;
      return t == null ? el.textContent : t;
    }

    function idOf(el) {
      var id = ids.get(el);
      if (!id) {
        id = next++;
        ids.set(el, id);
        byId.set(id, typeof WeakRef === "function" ? new WeakRef(el) : { deref: function () { return el; } });
      }
      return id;
    }

    function get(c) {
      if (c.doc && c.doc !== DOC) throw new Error("the page changed (it navigated or reloaded) since that observe; observe again for current ids");
      var n = Number(String(c.id == null ? "" : c.id).replace(/[[\]\s]/g, ""));
      var ref = byId.get(n);
      var el = ref && ref.deref();
      if (!el || el.isConnected === false) throw new Error("no element [" + c.id + "] on the page now; observe again for current ids");
      return el;
    }

    function roleOf(el, tag, st, parentCursor, inI) {
      var r = String(attr(el, "role") || "").trim().split(/\s+/)[0].toLowerCase();
      if (r && ROLES[r]) return r;
      switch (tag) {
        case "a":
        case "area":
          if (el.hasAttribute && el.hasAttribute("href")) return "link";
          break;
        case "button":
          return "button";
        case "input": {
          var t = inputType(el);
          if (t === "hidden") return null;
          return INPUT_ROLES[t] || "textbox";
        }
        case "textarea":
          return "textbox";
        case "select":
          return el.multiple || el.size > 1 ? "listbox" : "combobox";
        case "summary":
          return "button";
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          return "heading";
        case "iframe":
          return "frame";
      }
      var ce = attr(el, "contenteditable");
      if (ce != null && ce !== "false" && !inI) return "textbox";
      if (inI) return null;
      var ti = attr(el, "tabindex");
      if (ti != null && Number(ti) >= 0) return "focusable";
      if (el.hasAttribute && el.hasAttribute("onclick")) return "clickable";
      if (st.cursor === "pointer" && parentCursor !== "pointer") return "clickable";
      return null;
    }

    function labelsText(el) {
      var ls = el.labels;
      if (!ls || !ls.length) return "";
      var parts = [];
      for (var i = 0; i < ls.length; i++) parts.push(textOf(ls[i]));
      return parts.join(" ");
    }

    function nameOf(el, tag, role) {
      var by = attr(el, "aria-labelledby");
      if (by && document.getElementById) {
        var parts = by.split(/\s+/).map(function (i) {
          var n = document.getElementById(i);
          return n ? textOf(n) : "";
        });
        var t = norm(parts.join(" "));
        if (t) return t;
      }
      var al = norm(attr(el, "aria-label"));
      if (al) return al;
      if (tag === "input" || tag === "select" || tag === "textarea") {
        var l = norm(labelsText(el));
        if (l) return l;
        var ty = inputType(el);
        if (tag === "input" && (ty === "button" || ty === "submit" || ty === "reset")) return norm(el.value) || (ty === "submit" ? "Submit" : ty === "reset" ? "Reset" : "");
        if (tag === "input" && ty === "image") return norm(attr(el, "alt")) || "Submit";
      } else if (role !== "textbox" && role !== "frame") {
        var tx = norm(textOf(el));
        if (tx) return tx;
      }
      var title = norm(attr(el, "title"));
      if (title) return title;
      if (tag === "iframe") return norm(attr(el, "src"));
      if (el.querySelector) {
        var img = el.querySelector("img[alt]");
        if (img && norm(attr(img, "alt"))) return norm(attr(img, "alt"));
        var svgt = el.querySelector("svg title");
        if (svgt && norm(svgt.textContent)) return norm(svgt.textContent);
      }
      return "";
    }

    function hrefOf(el) {
      var h = el.href;
      if (h && typeof h === "object") h = h.baseVal; // SVG <a>
      h = String(h || attr(el, "href") || "");
      if (/^javascript:/i.test(h)) return "(script)";
      try {
        var u = new URL(h, location.href);
        if (u.origin === location.origin) h = u.pathname + u.search + u.hash;
      } catch (e) {}
      return cut(h, 120);
    }

    function boolAttr(el, a) {
      var v = attr(el, a);
      return v == null ? undefined : v === "true" ? true : v === "false" ? false : v;
    }

    function describe(el, tag, role, r, inView, focused) {
      var e = { id: idOf(el), role: role, name: cut(nameOf(el, tag, role), 100) };
      if (tag === "input") {
        var ty = inputType(el);
        if (ty !== "text" && !INPUT_ROLES[ty]) e.type = ty;
        if (ty === "checkbox" || ty === "radio") e.checked = !!el.checked;
      }
      if (tag === "input" || tag === "textarea") {
        if (secret(el)) {
          e.pw = true;
          e.filled = String(el.value || "").length > 0;
        } else if (tag === "textarea" || !/^(checkbox|radio|button|submit|reset|image|file)$/.test(inputType(el))) {
          var v = String(el.value == null ? "" : el.value);
          if (v) e.value = v.length > 200 ? v.slice(0, 199) + "…" : v;
        }
        var ph = norm(attr(el, "placeholder"));
        if (ph) e.ph = cut(ph, 80);
        if (el.readOnly) e.ro = true;
        if (el.required) e.req = true;
      } else if (tag === "select") {
        var o = el.options || [];
        var sel = [];
        var all = [];
        for (var i = 0; i < o.length; i++) {
          if (o[i].selected) sel.push(norm(o[i].text || o[i].label || o[i].value));
          if (all.length < 25) all.push(cut(o[i].text || o[i].label || o[i].value, 40));
        }
        e.value = sel.join(", ");
        e.opts = all;
        if (o.length > all.length) e.nopts = o.length;
      } else if (role === "textbox") {
        var cv = norm(textOf(el));
        if (cv) e.value = cut(cv, 200);
      } else if (role === "link") {
        e.href = hrefOf(el);
      } else if (role === "heading") {
        var lv = /^h([1-6])$/.exec(tag);
        e.level = lv ? Number(lv[1]) : Number(attr(el, "aria-level")) || undefined;
      }
      var ac = boolAttr(el, "aria-checked");
      if (ac !== undefined && e.checked === undefined) e.checked = ac;
      var ap = boolAttr(el, "aria-pressed");
      if (ap !== undefined) e.pressed = ap;
      var ax = boolAttr(el, "aria-expanded");
      if (ax !== undefined) e.expanded = ax;
      var as = boolAttr(el, "aria-selected");
      if (as !== undefined) e.selected = as;
      if (el.disabled === true || attr(el, "aria-disabled") === "true") e.disabled = true;
      if (focused) e.focused = true;
      e.x = Math.round(r.left);
      e.y = Math.round(r.top);
      e.w = Math.round(r.width);
      e.h = Math.round(r.height);
      if (!inView) e.off = true;
      return e;
    }

    function observe(c) {
      var vw = window.innerWidth || 0;
      var vh = window.innerHeight || 0;
      var all = !!c.all;
      var max = c.max || 250;
      var textMax = c.text_max == null ? 2500 : c.text_max;
      var els = [];
      var more = 0;
      var off = 0;
      var text = [];
      var textLen = 0;
      var textCut = false;
      var lastBlock = null;
      var visited = 0;
      var active = document.activeElement;
      var rects = typeof WeakMap === "function" ? new WeakMap() : null;

      function addText(s, block) {
        if (textCut) return;
        s = norm(s);
        if (!s) return;
        var sep = text.length ? (block !== lastBlock ? "\n" : " ") : "";
        lastBlock = block;
        if (textLen + sep.length + s.length > textMax) {
          s = s.slice(0, Math.max(0, textMax - textLen - sep.length));
          textCut = true;
          if (!s) return;
        }
        text.push(sep + s);
        textLen += sep.length + s.length;
      }

      function rec(node, ctx) {
        var kids = node.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
          var n = kids[i];
          if (n.nodeType === 3) {
            if (!ctx.inI && !ctx.hidden && ctx.inView && textMax > 0) addText(n.nodeValue, ctx.block);
            continue;
          }
          if (n.nodeType !== 1 || ours.has(n)) continue;
          var tag = tagOf(n);
          if (SKIP[tag]) continue;
          if (++visited > 30000) return;
          var st = getComputedStyle(n);
          if (!st || st.display === "none") continue;
          var hidden = ctx.hidden || st.visibility === "hidden" || st.visibility === "collapse" || st.opacity === "0";
          var r = n.getBoundingClientRect();
          if (rects) rects.set(n, r);
          var sized = r.width > 0 && r.height > 0;
          // Zero-size boxes (display: contents, empty inlines) take their parent's visibility.
          var inView = sized ? r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw : ctx.inView;
          var role = roleOf(n, tag, st, ctx.cursor, ctx.inI);
          if (role && !hidden && sized && (inView || all)) {
            if (els.length < max) els.push(describe(n, tag, role, r, inView, n === active));
            else more++;
            if (!inView) off++;
          }
          var block = st.display === "inline" || st.display === "inline-block" || st.display === "contents" ? ctx.block : n;
          var child = { inI: ctx.inI || (!!role && role !== "heading"), hidden: hidden, inView: inView, cursor: st.cursor, block: block };
          if (tag !== "iframe" && tag !== "select" && tag !== "svg") {
            rec(n, child);
            if (n.shadowRoot) rec(n.shadowRoot, child);
          }
        }
      }
      var root = document.body || document.documentElement;
      if (root) rec({ childNodes: [root] }, { inI: false, hidden: false, inView: true, cursor: "auto", block: null });
      var se = document.scrollingElement || document.documentElement || {};
      var focus = active && ids.get(active);
      return {
        doc: DOC,
        url: String(location.href),
        title: norm(document.title),
        ready: document.readyState,
        vw: vw,
        vh: vh,
        sx: Math.round(window.scrollX || 0),
        sy: Math.round(window.scrollY || 0),
        sw: Math.round(se.scrollWidth || 0),
        sh: Math.round(se.scrollHeight || 0),
        els: els,
        more: more,
        off: off,
        focus: focus || undefined,
        text: text.join(""),
        cut: textCut || undefined,
      };
    }

    // ---- actions ----

    function ev(el, type, Ctor, init) {
      var C = typeof g[Ctor] === "function" ? g[Ctor] : typeof MouseEvent === "function" && /Pointer/.test(Ctor) ? MouseEvent : Event;
      var e;
      try {
        e = new C(type, init);
      } catch (x) {
        e = new Event(type, init);
      }
      el.dispatchEvent(e);
      return e;
    }

    function rectOf(el) {
      return el.getBoundingClientRect();
    }
    /** Some of it shows (it is clicked at the middle of the part that shows). */
    function inViewport(r) {
      return r.bottom > 0 && r.right > 0 && r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0);
    }
    function reveal(el) {
      var r = rectOf(el);
      if (!inViewport(r) && el.scrollIntoView) {
        try {
          el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        } catch (e) {
          el.scrollIntoView(false);
        }
        r = rectOf(el);
      }
      return r;
    }

    function flash(r) {
      if (!document.createElement) return;
      try {
        var d = document.createElement("div");
        ours.add(d);
        d.setAttribute("aria-hidden", "true");
        d.style.cssText =
          "all:initial;position:fixed;box-sizing:border-box;pointer-events:none;z-index:2147483647;border-radius:6px;" +
          "border:2px solid rgba(10,132,255,.95);background:rgba(10,132,255,.13);box-shadow:0 0 0 4px rgba(10,132,255,.18);" +
          "transition:opacity .3s ease;opacity:1;left:" + (r.left - 3) + "px;top:" + (r.top - 3) + "px;width:" + (r.width + 6) + "px;height:" + (r.height + 6) + "px";
        (document.documentElement || document.body).appendChild(d);
        setTimeout(function () {
          d.style.opacity = "0";
          setTimeout(function () {
            if (d.parentNode) d.parentNode.removeChild(d);
          }, 350);
        }, 500);
      } catch (e) {}
    }

    function short(el) {
      var tag = tagOf(el);
      var role = roleOf(el, tag, { cursor: "" }, "", false) || tag;
      var n = cut(nameOf(el, tag, role), 60);
      return n ? role + ' "' + n + '"' : role;
    }

    function point(r) {
      var vw = window.innerWidth || 0;
      var vh = window.innerHeight || 0;
      var x0 = Math.max(0, r.left);
      var y0 = Math.max(0, r.top);
      var x1 = Math.min(vw, r.right);
      var y1 = Math.min(vh, r.bottom);
      return x1 > x0 && y1 > y0 ? [(x0 + x1) / 2, (y0 + y1) / 2] : [r.left + r.width / 2, r.top + r.height / 2];
    }

    function focusEl(el) {
      if (el.focus) {
        try {
          el.focus({ preventScroll: true });
        } catch (e) {
          el.focus();
        }
      }
    }

    function click(c) {
      var el = get(c);
      var r = reveal(el);
      var p = point(r);
      var note = null;
      if (document.elementFromPoint) {
        var top = document.elementFromPoint(p[0], p[1]);
        if (top && top !== el && !(el.contains && el.contains(top)) && !(top.contains && top.contains(el)) && !ours.has(top)) note = "at that point the page shows " + short(top) + " on top";
      }
      if (el.disabled === true) note = "it is disabled";
      flash(r);
      var base = { bubbles: true, cancelable: true, composed: true, clientX: p[0], clientY: p[1], screenX: p[0], screenY: p[1], button: 0, view: window };
      var pd = Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }, base);
      ev(el, "pointerover", "PointerEvent", pd);
      ev(el, "mouseover", "MouseEvent", base);
      ev(el, "pointerdown", "PointerEvent", pd);
      var md = ev(el, "mousedown", "MouseEvent", Object.assign({ buttons: 1, detail: 1 }, base));
      if (!md.defaultPrevented) focusEl(el);
      ev(el, "pointerup", "PointerEvent", Object.assign({}, pd, { buttons: 0 }));
      ev(el, "mouseup", "MouseEvent", Object.assign({ detail: 1 }, base));
      if (typeof el.click === "function") el.click();
      else ev(el, "click", "MouseEvent", Object.assign({ detail: 1 }, base));
      return { what: short(el), x: Math.round(p[0]), y: Math.round(p[1]), note: note };
    }

    function setValue(el, v) {
      var p = Object.getPrototypeOf(el);
      var d = null;
      while (p && !(d = Object.getOwnPropertyDescriptor(p, "value"))) p = Object.getPrototypeOf(p);
      if (d && d.set) d.set.call(el, v);
      else el.value = v;
    }

    function inputEvent(el, type, data, inputType) {
      return ev(el, type, "InputEvent", { bubbles: true, cancelable: type === "beforeinput", composed: true, data: data, inputType: inputType || "insertText" });
    }

    function editable(el) {
      var tag = tagOf(el);
      if (tag === "textarea") return true;
      if (tag === "input") return !!TEXT_TYPES[inputType(el)] || !INPUT_ROLES[inputType(el)];
      var ce = attr(el, "contenteditable");
      return el.isContentEditable === true || (ce != null && ce !== "false");
    }

    /** The text field `el` stands for: itself, or the one inside it (a wrapper the page made clickable). */
    function field(el) {
      if (editable(el)) return el;
      if (el.querySelector) {
        var f = el.querySelector("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable]:not([contenteditable=false])");
        if (f) return f;
      }
      if (tagOf(el) === "label" && el.control && editable(el.control)) return el.control;
      return null;
    }

    function type(c) {
      var el0 = get(c);
      var el = field(el0);
      if (!el) throw new Error(short(el0) + " is not a text field (click checkboxes and buttons; use browser_select for a <select>)");
      if (el.disabled) throw new Error(short(el) + " is disabled");
      if (el.readOnly) throw new Error(short(el) + " is read-only");
      var text = String(c.text == null ? "" : c.text);
      var r = reveal(el);
      flash(r);
      focusEl(el);
      var tag = tagOf(el);
      var hidden = secret(el);
      if (tag === "input" || tag === "textarea") {
        if (el.select) el.select();
        inputEvent(el, "beforeinput", text, "insertReplacementText");
        setValue(el, text);
        inputEvent(el, "input", text, "insertReplacementText");
        ev(el, "change", "Event", { bubbles: true });
      } else {
        var done = false;
        try {
          var sel = window.getSelection && window.getSelection();
          if (sel && document.createRange) {
            var range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
            done = document.execCommand && document.execCommand("insertText", false, text);
          }
        } catch (e) {}
        if (!done) {
          el.textContent = text;
          inputEvent(el, "input", text, "insertReplacementText");
        }
      }
      var res = { what: short(el), len: text.length, masked: hidden || undefined };
      if (!hidden && (tag === "input" || tag === "textarea") && String(el.value) !== text) res.now = cut(el.value, 120);
      if (c.submit) res.submit = enter(el);
      return res;
    }

    var KEYS = {
      enter: ["Enter", "Enter", 13], return: ["Enter", "Enter", 13], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27],
      esc: ["Escape", "Escape", 27], backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46],
      space: [" ", "Space", 32], " ": [" ", "Space", 32], arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38],
      arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40], arrowleft: ["ArrowLeft", "ArrowLeft", 37],
      left: ["ArrowLeft", "ArrowLeft", 37], arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
      home: ["Home", "Home", 36], end: ["End", "End", 35], pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
    };
    function keyInfo(name) {
      var k = KEYS[String(name).toLowerCase()];
      if (k) return k;
      var s = String(name);
      if (s.length === 1) {
        var up = s.toUpperCase();
        var code = /[a-z]/i.test(s) ? "Key" + up : /[0-9]/.test(s) ? "Digit" + s : "";
        return [s, code, up.charCodeAt(0)];
      }
      throw new Error("unknown key " + JSON.stringify(name) + " (Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown, or one character)");
    }
    function keyEv(el, type, k, m) {
      return ev(el, type, "KeyboardEvent", {
        key: k[0], code: k[1], keyCode: k[2], which: k[2], bubbles: true, cancelable: true, composed: true,
        shiftKey: !!m.shift, ctrlKey: !!m.control, altKey: !!m.option, metaKey: !!m.command,
      });
    }

    function buttonish(el) {
      var tag = tagOf(el);
      var role = String(attr(el, "role") || "");
      return tag === "button" || tag === "summary" || (tag === "a" && el.hasAttribute("href")) ||
        (tag === "input" && /^(button|submit|reset|image|checkbox|radio)$/.test(inputType(el))) || /^(button|link|menuitem|tab|option|checkbox|radio|switch)$/.test(role);
    }

    /** Enter on `el`, with the browser's default action (submit the form, activate a button / link). */
    function enter(el) {
      var k = KEYS.enter;
      var d = keyEv(el, "keydown", k, {});
      var did = "";
      if (!d.defaultPrevented) {
        var p = keyEv(el, "keypress", k, {});
        var tag = tagOf(el);
        if (!p.defaultPrevented) {
          if (tag === "input" && el.form) {
            var f = el.form;
            var btn = f.querySelector && f.querySelector("button[type=submit], button:not([type]), input[type=submit], input[type=image]");
            if (btn && !btn.disabled) {
              btn.click();
              did = "submitted the form (" + short(btn) + ")";
            } else if (f.requestSubmit) {
              f.requestSubmit();
              did = "submitted the form";
            }
          } else if (tag === "textarea" || (tag !== "input" && editable(el))) {
            if (!(document.execCommand && document.execCommand("insertLineBreak"))) {
              if (tag === "textarea") setValue(el, el.value + "\n");
              inputEvent(el, "input", "\n", "insertLineBreak");
            }
            did = "new line";
          } else if (buttonish(el) && el.click) {
            el.click();
            did = "activated " + short(el);
          }
        }
      } else did = "the page handled it";
      keyEv(el, "keyup", k, {});
      return did;
    }

    function tabbables() {
      var out = [];
      var all = document.querySelectorAll ? document.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]") : [];
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var ti = attr(el, "tabindex");
        if ((ti != null && Number(ti) < 0) || el.disabled || (tagOf(el) === "input" && inputType(el) === "hidden")) continue;
        var r = rectOf(el);
        if (r.width <= 0 || r.height <= 0) continue;
        out.push(el);
      }
      return out;
    }

    function press(c) {
      var m = {};
      (c.modifiers || []).forEach(function (x) {
        m[String(x).toLowerCase().replace(/^(ctrl|cmd|meta|alt|opt)$/, function (s) {
          return { ctrl: "control", cmd: "command", meta: "command", alt: "option", opt: "option" }[s];
        })] = true;
      });
      var el = c.id != null ? get(c) : document.activeElement || document.body;
      if (c.id != null) {
        flash(reveal(el));
        focusEl(el);
      }
      var k = keyInfo(c.key);
      if (k[0] === "Enter" && !m.shift && !m.control && !m.option && !m.command) return { key: "Enter", on: short(el), did: enter(el) };
      var d = keyEv(el, "keydown", k, m);
      var did = "";
      var ed = editable(el);
      if (!d.defaultPrevented) {
        var plain = !m.control && !m.command && !m.option;
        if (k[0].length === 1 && plain) {
          var p = keyEv(el, "keypress", k, m);
          var ch = m.shift ? k[0].toUpperCase() : k[0];
          if (!p.defaultPrevented && ed) {
            if (!(document.execCommand && document.execCommand("insertText", false, ch))) {
              setValue(el, String(el.value || "") + ch);
              inputEvent(el, "input", ch, "insertText");
            }
            did = "typed " + JSON.stringify(ch);
          } else if (k[0] === " " && buttonish(el) && el.click) {
            el.click();
            did = "activated " + short(el);
          } else if (k[0] === " ") {
            window.scrollBy(0, (window.innerHeight || 600) * (m.shift ? -0.8 : 0.8));
            did = "scrolled";
          }
        } else if (k[0] === "Tab") {
          var list = tabbables();
          var i = list.indexOf(el);
          var to = list[(i + (m.shift ? -1 : 1) + list.length) % Math.max(1, list.length)];
          if (to) {
            focusEl(to);
            did = "focus moved to " + short(to);
          }
        } else if ((k[0] === "Backspace" || k[0] === "Delete") && ed) {
          if (!(document.execCommand && document.execCommand(k[0] === "Backspace" ? "delete" : "forwardDelete"))) {
            var v = String(el.value || "");
            setValue(el, k[0] === "Backspace" ? v.slice(0, -1) : v);
            inputEvent(el, "input", null, k[0] === "Backspace" ? "deleteContentBackward" : "deleteContentForward");
          }
          did = "deleted";
        } else if (tagOf(el) === "select" && (k[0] === "ArrowDown" || k[0] === "ArrowUp")) {
          var ni = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + (k[0] === "ArrowDown" ? 1 : -1)));
          if (ni !== el.selectedIndex) {
            el.selectedIndex = ni;
            ev(el, "input", "Event", { bubbles: true });
            ev(el, "change", "Event", { bubbles: true });
            did = "selected " + JSON.stringify(norm(el.options[ni].text));
          }
        } else if (!ed && /^(ArrowDown|ArrowUp|PageDown|PageUp|Home|End)$/.test(k[0])) {
          var vh = window.innerHeight || 600;
          var dy = { ArrowDown: 40, ArrowUp: -40, PageDown: vh * 0.85, PageUp: -vh * 0.85 }[k[0]];
          if (k[0] === "Home") window.scrollTo(window.scrollX || 0, 0);
          else if (k[0] === "End") window.scrollTo(window.scrollX || 0, (document.scrollingElement || document.documentElement).scrollHeight);
          else window.scrollBy(0, dy);
          did = "scrolled";
        }
      } else did = "the page handled it";
      keyEv(el, "keyup", k, m);
      return { key: k[0], on: short(el), did: did };
    }

    function select(c) {
      var el = get(c);
      if (tagOf(el) !== "select") throw new Error(short(el) + " is not a <select>; click its options instead");
      if (el.disabled) throw new Error(short(el) + " is disabled");
      var want = c.values ? c.values : [c.value != null ? c.value : c.label];
      var o = el.options;
      var picked = [];
      var match = function (opt, w) {
        w = norm(w).toLowerCase();
        return norm(opt.value).toLowerCase() === w || norm(opt.text).toLowerCase() === w || norm(opt.label).toLowerCase() === w;
      };
      if (c.index != null && !c.values && c.value == null && c.label == null) {
        if (!o[c.index]) throw new Error("no option at index " + c.index + " (" + o.length + " options)");
        picked.push(o[c.index]);
      } else {
        want.forEach(function (w) {
          for (var i = 0; i < o.length; i++)
            if (match(o[i], w)) {
              picked.push(o[i]);
              return;
            }
          throw new Error("no option " + JSON.stringify(w) + " in " + short(el) + "; options: " + Array.prototype.slice.call(o, 0, 25).map(function (x) {
            return JSON.stringify(norm(x.text));
          }).join(", "));
        });
      }
      flash(reveal(el));
      focusEl(el);
      for (var i = 0; i < o.length; i++) if (el.multiple) o[i].selected = picked.indexOf(o[i]) >= 0;
      if (!el.multiple) setValue(el, picked[0].value);
      ev(el, "input", "Event", { bubbles: true });
      ev(el, "change", "Event", { bubbles: true });
      return { what: short(el), picked: picked.map(function (x) { return norm(x.text); }) };
    }

    function scrollable(el) {
      var st = getComputedStyle(el);
      return /(auto|scroll|overlay)/.test(st.overflowY + " " + st.overflowX) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    }

    function mainScroller() {
      var se = document.scrollingElement || document.documentElement;
      if (se.scrollHeight > se.clientHeight + 1) return null; // the page itself
      // An app whose body doesn't scroll: the largest visible scrolling box.
      var best = null;
      var area = 0;
      var all = document.querySelectorAll ? document.querySelectorAll("body *") : [];
      for (var i = 0; i < all.length && i < 20000; i++) {
        var el = all[i];
        if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) continue;
        if (!scrollable(el)) continue;
        var r = rectOf(el);
        var a = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
        if (a > area) {
          area = a;
          best = el;
        }
      }
      return best;
    }

    function scroll(c) {
      var dir = c.direction || c.dir;
      if (c.id != null && !dir) {
        var t = get(c);
        try {
          t.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        } catch (e) {
          t.scrollIntoView();
        }
        return { did: "scrolled " + short(t) + " into view" };
      }
      dir = String(dir || "down").toLowerCase();
      var box = null;
      if (c.id != null) {
        box = get(c);
        while (box && box !== document.body && box !== document.documentElement && !scrollable(box)) box = box.parentElement;
        if (box === document.body || box === document.documentElement) box = null;
      } else box = mainScroller();
      var se = document.scrollingElement || document.documentElement;
      var cw = box ? box.clientWidth : window.innerWidth;
      var chh = box ? box.clientHeight : window.innerHeight;
      var amount = c.amount == null ? 0.8 : Math.max(0.05, Math.min(10, Number(c.amount)));
      var pos = function () {
        return box ? [box.scrollLeft, box.scrollTop] : [window.scrollX, window.scrollY];
      };
      var before = pos();
      var opts = { behavior: "instant" };
      if (dir === "top" || dir === "bottom") {
        opts.top = dir === "top" ? 0 : (box || se).scrollHeight;
        (box || window).scrollTo(opts);
      } else {
        opts.top = dir === "down" ? chh * amount : dir === "up" ? -chh * amount : 0;
        opts.left = dir === "right" ? cw * amount : dir === "left" ? -cw * amount : 0;
        if (!/^(up|down|left|right)$/.test(dir)) throw new Error("direction is up, down, left, right, top or bottom");
        (box || window).scrollBy(opts);
      }
      var after = pos();
      var max = box ? [box.scrollWidth - box.clientWidth, box.scrollHeight - box.clientHeight] : [se.scrollWidth - window.innerWidth, se.scrollHeight - window.innerHeight];
      var where = box ? short(box) : "the page";
      var moved = Math.round(after[1] - before[1] + (after[0] - before[0]));
      return {
        did: moved === 0 ? "couldn't scroll " + where + " " + dir + " (already at the end)" : "scrolled " + where + " " + dir + " by " + Math.abs(moved) + " px",
        y: Math.round(after[1]),
        max_y: Math.max(0, Math.round(max[1])),
      };
    }

    function visibleEl(el) {
      if (!el) return false;
      var r = rectOf(el);
      if (!(r.width > 0 && r.height > 0)) return false;
      var st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none";
    }

    function find(c) {
      if (c.selector) {
        var el;
        try {
          el = document.querySelector(c.selector);
        } catch (e) {
          throw new Error("invalid CSS selector " + JSON.stringify(c.selector));
        }
        return { found: visibleEl(el), url: String(location.href) };
      }
      if (c.text != null) {
        var t = norm(c.text).toLowerCase();
        var b = document.body;
        var txt = norm((b && textOf(b)) || "").toLowerCase() + " " + norm(document.title).toLowerCase();
        return { found: txt.indexOf(t) >= 0, url: String(location.href) };
      }
      return { found: true, url: String(location.href) };
    }

    return {
      run: function (c) {
        switch (c.op) {
          case "observe":
            return observe(c);
          case "click":
            return click(c);
          case "type":
            return type(c);
          case "select":
            return select(c);
          case "press":
            return press(c);
          case "scroll":
            return scroll(c);
          case "find":
            return find(c);
          case "idle":
            return { quiet: now() - lastMutation, mutations: mutations, ready: document.readyState, doc: DOC, url: String(location.href) };
          case "flash": {
            var el = get(c);
            flash(reveal(el));
            return { what: short(el) };
          }
          default:
            throw new Error("unknown op " + c.op);
        }
      },
    };
  }
})
