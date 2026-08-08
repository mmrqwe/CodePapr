(function () {
  'use strict';

  if (window.papr) return;

  var IPC_IDLE_TIMEOUT_MS = 300000;
  var pending = {};
  var appInfo = null;
  var parentOrigin = window.__PAPR_PARENT_ORIGIN || '*';
  var currentTheme = null;
  var themeListeners = [];

  function applyTheme(payload) {
    var value = payload && payload.dark ? 'dark' : 'light';
    if (currentTheme === value) return;
    currentTheme = value;
    var root = document.documentElement;
    if (root) {
      root.setAttribute('data-theme', value);
      try { root.style.colorScheme = value; } catch (e) { /* older engines */ }
    }
    for (var i = 0; i < themeListeners.length; i++) {
      try { themeListeners[i](value); } catch (e) { /* listener errors are isolated */ }
    }
    try { window.dispatchEvent(new CustomEvent('papr-theme-change', { detail: { theme: value } })); } catch (e) { /* noop */ }
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

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || !data.__papr) return;

    if (data.type === 'papr://theme') {
      applyTheme(data.payload);
      return;
    }

    var reqId = data.reqId;
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
      get: function (url, maxBytes) {
        return send('papr://http.get', { url: url, maxBytes: maxBytes });
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
      readFile: function (path, maxBytes) {
        return send('papr://fs.read', { path: path, maxBytes: maxBytes });
      },
      writeFile: function (path, content) {
        return send('papr://fs.write', { path: path, content: content });
      },
      list: function (path) {
        return send('papr://fs.list', { path: path });
      },
      delete: function (path) {
        return send('papr://fs.delete', { path: path });
      }
    },
    app: {
      info: function () {
        if (appInfo) return Promise.resolve(appInfo);
        return send('papr://app.info').then(function (info) {
          info.backendUrl = window.__PAPR_BACKEND_URL || null;
          appInfo = info;
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
})();
