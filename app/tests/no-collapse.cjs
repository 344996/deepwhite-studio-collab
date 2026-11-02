/* For browser tests about something other than U03: since nodes keep their details folded until clicked,
   these tests drive node controls directly, so the folding is left out of the page. U03 itself is covered
   by check-result-collapse.cjs. Call it after any catch-all route, because the newest route wins. */
'use strict';
module.exports = page => page.route(/studio-result-collapse\.(js|css)/, route => route.fulfill({
  status: 200, contentType: route.request().url().includes('.css') ? 'text/css' : 'text/javascript', body: '',
}));
