// If a script fails to download (weak signal), the app never starts: after 15 s offer a reload
// instead of an endless spinner. Plain script (no modules) so it runs even when the rest fails.
(function () {
  setTimeout(function () {
    var l = document.getElementById('screenLoading') || document.getElementById('loading');
    if (!l || l.hidden || window.__dcrBooted) return;
    l.innerHTML = '<p>Could not load the page. Check your connection.<br>' +
      '<span lang="ar" dir="rtl">تعذّر تحميل الصفحة. تأكد من الاتصال.</span></p>' +
      '<button type="button" class="btn primary" id="fallbackReload">Retry / إعادة المحاولة</button>';
    document.getElementById('fallbackReload').addEventListener('click', function () { location.reload(); });
  }, 15000);
}());
