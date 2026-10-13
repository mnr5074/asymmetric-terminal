// netcache.js: loaded first. Shares identical in-flight GET /api/* requests and reuses their result for 8s, so panels that ask for
// the same endpoint on page load (copytrade, narratives, ...) trigger one request instead of several. Non-GET and other URLs untouched.
'use strict';
(function () {
  const orig = window.fetch.bind(window); const M = new Map(); const TTL = 8e3;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const method = (init && init.method) || (input && input.method) || 'GET';
    if (!url || method.toUpperCase() !== 'GET' || !/^\/api\//.test(url.replace(location.origin, '')) || (init && init.headers && Object.keys(init.headers).length)) return orig(input, init);
    const hit = M.get(url);
    if (hit && Date.now() - hit.t < TTL) return hit.p.then((r) => r.clone());
    const p = orig(input, init).then((r) => { if (!r.ok) M.delete(url); return r; }, (e) => { M.delete(url); throw e; });
    M.set(url, { t: Date.now(), p }); if (M.size > 200) M.delete(M.keys().next().value);
    return p.then((r) => r.clone());
  };
})();
