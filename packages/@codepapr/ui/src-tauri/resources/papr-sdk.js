(function () {
  'use strict';

  if (window.papr) return;

  var IPC_IDLE_TIMEOUT_MS = 300000;
  // 原型安全：普通对象字面量的 pending['__proto__'] 会命中 Object.prototype
  //（truthy 通过存在性检查，armIdleTimer 还会把 timer 写进原型，污染页面内
  // 所有对象）。null 原型对象上 '__proto__'/'constructor' 只是普通键。
  var pending = Object.create(null);
  var parentOrigin = window.__PAPR_PARENT_ORIGIN || '*';
  var currentTheme = null;
  var themeListeners = [];
  var boundsListeners = [];
  // app_publish 下行事件订阅表：channel -> [cb]（null 原型，防原型键污染）
  var eventListeners = Object.create(null);

  function dispatchAppEvent(payload) {
    var channel = payload && typeof payload.channel === 'string' ? payload.channel : '';
    if (!channel) return;
    // 原型键防御：与 pending 同理，'__proto__' 等在 null 原型对象上只是普通键，
    // 但仍显式拒绝，避免监听表被构造出意外分支。
    if (channel === '__proto__' || channel === 'constructor' || channel === 'prototype') return;
    var listeners = eventListeners[channel];
    if (!listeners) return;
    var event = {
      channel: channel,
      seq: payload && typeof payload.seq === 'number' ? payload.seq : 0,
      ts: payload && typeof payload.ts === 'number' ? payload.ts : 0,
      payload: payload ? payload.payload : undefined
    };
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](event); } catch (e) { /* listener errors are isolated */ }
    }
    try { window.dispatchEvent(new CustomEvent('papr-app-event', { detail: event })); } catch (e) { /* noop */ }
  }

  function applyTheme(payload) {
    // 协议 v2：{ theme: 'paper-dark', mode: 'dark', dark: true }
    // 协议 v1（向后兼容）：{ dark: true } → 深浅二元
    var themeId = payload && typeof payload.theme === 'string' && payload.theme ? payload.theme : null;
    var mode = payload && (payload.mode === 'dark' || payload.mode === 'light') ? payload.mode : null;
    var dark = payload ? !!payload.dark : false;
    var nextMode = mode || (dark ? 'dark' : 'light');
    var nextTheme = themeId || (nextMode === 'dark' ? 'paper-dark' : 'paper-light');
    var stateKey = nextTheme + '|' + nextMode;
    if (currentTheme === stateKey) return;
    currentTheme = stateKey;
    var root = document.documentElement;
    if (root) {
      root.setAttribute('data-theme', nextTheme);
      root.setAttribute('data-mode', nextMode);
      root.classList.toggle('dark', nextMode === 'dark');
      try { root.style.colorScheme = nextMode; } catch (e) { /* older engines */ }
    }
    for (var i = 0; i < themeListeners.length; i++) {
      try { themeListeners[i](nextMode); } catch (e) { /* listener errors are isolated */ }
    }
    try { window.dispatchEvent(new CustomEvent('papr-theme-change', { detail: { theme: nextTheme, mode: nextMode } })); } catch (e) { /* noop */ }
  }

  function armIdleTimer(reqId) {
    var entry = pending[reqId];
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(function () {
      var p = pending[reqId];
      if (p) {
        delete pending[reqId];
        p.reject(new Error('Papr IPC timeout: ' + p.type + ' (reqId=' + reqId + ')'));
      }
    }, IPC_IDLE_TIMEOUT_MS);
  }

  function send(type, payload, onProgress) {
    var reqId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

    var promise = new Promise(function (resolve, reject) {
      pending[reqId] = {
        resolve: resolve,
        reject: reject,
        onProgress: onProgress,
        type: type,
        timer: null
      };

      window.parent.postMessage({
        __papr: true,
        reqId: reqId,
        type: type,
        payload: payload
      }, parentOrigin);

      armIdleTimer(reqId);
    });

    promise.reqId = reqId;
    return promise;
  }

  // #26：与父侧 usePaprBridge 的 origin+source 双校验对等——只接受嵌入页
  // （window.parent）发来的消息。旧实现不校验来源：任何持有本窗口引用的
  // 页面（如恶意弹窗）都能伪造 papr 响应/主题消息。
  function isFromParent(event) {
    return event.source === window.parent;
  }

  window.addEventListener('message', function (event) {
    if (!isFromParent(event)) return;
    var data = event.data;
    if (!data || !data.__papr) return;

    if (data.type === 'papr://theme') {
      applyTheme(data.payload);
      return;
    }

    // app_publish 下行推送（无 reqId）：主窗口在事件落库后广播给已挂载的 iframe。
    // isFromParent 已校验来源，非父窗口的伪造事件到不了这里。
    if (data.type === 'papr://event') {
      dispatchAppEvent(data.payload);
      return;
    }

    if (data.type === 'papr://window.bounds') {
      for (var bi = 0; bi < boundsListeners.length; bi++) {
        try { boundsListeners[bi](data.payload); } catch (e) { /* listener errors are isolated */ }
      }
      return;
    }

    var reqId = data.reqId;
    // 防御性校验（null 原型下本不必要）：拒绝原型相关键名，杜绝任何
    // 原型链访问路径。
    if (reqId === '__proto__' || reqId === 'constructor' || reqId === 'prototype') {
      return;
    }
    var p = pending[reqId];
    if (!p) return;

    if (data.type === 'stream') {
      armIdleTimer(reqId);
      if (p.onProgress) p.onProgress(data.event);
      return;
    }

    if (p.timer) clearTimeout(p.timer);
    delete pending[reqId];
    if (data.error) {
      var err = new Error(data.error.message || 'Papr IPC error');
      if (data.error.code) err.code = data.error.code;
      if (data.error.detail) err.detail = data.error.detail;
      p.reject(err);
    } else {
      p.resolve(data.result);
    }
  });

  window.papr = {
    db: {
      get: function (key) {
        return send('papr://db.get', { key: key }).then(function (raw) {
          if (raw === null || raw === undefined) return null;
          try { return JSON.parse(raw); } catch (e) { return raw; }
        });
      },
      set: function (key, value) {
        return send('papr://db.set', { key: key, value: value });
      },
      delete: function (key) {
        return send('papr://db.delete', { key: key });
      },
      keys: function () {
        return send('papr://db.keys');
      }
    },
    agent: {
      run: function (opts, onProgress) {
        return send('papr://agent.run', {
          agent: opts.agent,
          agentName: opts.agent,
          task: opts.task,
          model: opts.model
        }, onProgress);
      },
      cancel: function (reqId) {
        return send('papr://agent.cancel', { reqId: reqId });
      }
    },
    http: {
      request: function (opts) {
        opts = opts || {};
        return send('papr://http.request', {
          method: opts.method,
          url: opts.url,
          headers: opts.headers,
          body: opts.body,
          maxBytes: opts.maxBytes
        });
      },
      get: function (url, maxBytesOrOpts) {
        if (maxBytesOrOpts && typeof maxBytesOrOpts === 'object') {
          return send('papr://http.request', {
            method: 'GET',
            url: url,
            headers: maxBytesOrOpts.headers,
            maxBytes: maxBytesOrOpts.maxBytes
          });
        }
        return send('papr://http.get', { url: url, maxBytes: maxBytesOrOpts });
      },
      post: function (url, body, contentType) {
        return send('papr://http.post', {
          url: url,
          body: body,
          contentType: contentType
        });
      }
    },
    fs: {
      readFile: function (path, maxBytesOrOpts) {
        if (maxBytesOrOpts && typeof maxBytesOrOpts === 'object') {
          return send('papr://fs.read', {
            path: path,
            maxBytes: maxBytesOrOpts.maxBytes,
            encoding: maxBytesOrOpts.encoding
          });
        }
        return send('papr://fs.read', { path: path, maxBytes: maxBytesOrOpts });
      },
      writeFile: function (path, content, opts) {
        return send('papr://fs.write', {
          path: path,
          content: content,
          encoding: opts && opts.encoding
        });
      },
      exists: function (path) {
        return send('papr://fs.exists', { path: path });
      },
      list: function (path) {
        return send('papr://fs.list', { path: path });
      },
      delete: function (path) {
        return send('papr://fs.delete', { path: path });
      }
    },
    events: {
      // 订阅编程 Agent 经 app_publish 推送到本频道的事件（实时下行）。
      // 回调收到 { channel, seq, ts, payload }；返回取消订阅函数。
      // 历史事件用 papr.db.get('inbox:<channel>') 读取。
      on: function (channel, cb) {
        if (typeof channel !== 'string' || !channel || typeof cb !== 'function') {
          return function unsubscribe() {};
        }
        if (!eventListeners[channel]) eventListeners[channel] = [];
        eventListeners[channel].push(cb);
        return function unsubscribe() {
          var list = eventListeners[channel];
          if (!list) return;
          var idx = list.indexOf(cb);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) delete eventListeners[channel];
        };
      }
    },
    window: {
      getBounds: function () {
        return send('papr://window.getBounds');
      },
      setSize: function (opts) {
        return send('papr://window.setSize', opts || {});
      },
      onBounds: function (cb) {
        if (typeof cb !== 'function') {
          return function unsubscribe() {};
        }
        boundsListeners.push(cb);
        return function unsubscribe() {
          var idx = boundsListeners.indexOf(cb);
          if (idx >= 0) boundsListeners.splice(idx, 1);
        };
      }
    },
    app: {
      info: function () {
        return send('papr://app.info').then(function (info) {
          if (info && typeof info === 'object') {
            info.backendUrl = window.__PAPR_BACKEND_URL || info.backendUrl || null;
          }
          return info;
        });
      },
      backendUrl: function () {
        return window.__PAPR_BACKEND_URL || null;
      },
      theme: function () {
        return currentTheme;
      },
      onThemeChange: function (cb) {
        if (typeof cb === 'function') {
          themeListeners.push(cb);
          if (currentTheme) cb(currentTheme);
        }
        return function unsubscribe() {
          var idx = themeListeners.indexOf(cb);
          if (idx >= 0) themeListeners.splice(idx, 1);
        };
      }
    }
  };

  // 父窗口加载检测握手：SDK 执行即证明真实应用页面已渲染（协议层错误页
  // 404/403 不注入 SDK）。父侧 AppModal 以此区分「加载失败」与「页面正常」，
  // 因为 iframe 的 onLoad 对协议错误响应同样会触发。
  try {
    window.parent.postMessage({ __papr: true, type: 'papr://app-ready' }, parentOrigin);
  } catch (e) { /* 跨源受限时忽略：父侧有超时兜底 */ }

  function emitConsole(level, args) {
    try {
      var parts = [];
      for (var i = 0; i < args.length; i++) {
        var value = args[i];
        if (typeof value === 'string') {
          parts.push(value);
        } else {
          try {
            parts.push(JSON.stringify(value));
          } catch (err) {
            parts.push(String(value));
          }
        }
      }
      window.parent.postMessage({
        __papr: true,
        type: 'papr://console',
        payload: { level: level, message: parts.join(' '), ts: Date.now() }
      }, parentOrigin);
    } catch (e) { /* 父窗口不可达时忽略 */ }
  }

  var nativeConsole = window.console || {};
  var levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (var li = 0; li < levels.length; li++) {
    (function (level) {
      var orig = nativeConsole[level] ? nativeConsole[level].bind(nativeConsole) : function () {};
      nativeConsole[level] = function () {
        emitConsole(level, arguments);
        try { orig.apply(nativeConsole, arguments); } catch (e) { /* noop */ }
      };
    })(levels[li]);
  }

  window.addEventListener('error', function (event) {
    emitConsole('error', [event.message || 'Uncaught error', event.filename || '', event.lineno || '']);
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    emitConsole('error', ['Unhandled rejection', reason]);
  });
})();
