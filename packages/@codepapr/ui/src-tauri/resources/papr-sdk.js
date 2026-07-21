(function () {
  'use strict';

  if (window.papr) return;

  var pending = {};
  var appInfo = null;

  function send(type, payload, onProgress) {
    return new Promise(function (resolve, reject) {
      var reqId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
      pending[reqId] = {
        resolve: resolve,
        reject: reject,
        onProgress: onProgress
      };

      window.parent.postMessage({
        __papr: true,
        reqId: reqId,
        type: type,
        payload: payload
      }, '*');

      setTimeout(function () {
        if (pending[reqId]) {
          delete pending[reqId];
          reject(new Error('Papr IPC timeout'));
        }
      }, 300000);
    });
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || !data.__papr) return;
    var reqId = data.reqId;
    var p = pending[reqId];
    if (!p) return;

    if (data.type === 'stream') {
      if (p.onProgress) p.onProgress(data.event);
      return;
    }

    delete pending[reqId];
    if (data.error) {
      p.reject(new Error(data.error.message || 'Papr IPC error'));
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
          agentName: opts.agent,
          task: opts.task,
          model: opts.model
        }, onProgress);
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
          appInfo = info;
          return info;
        });
      }
    }
  };
})();
