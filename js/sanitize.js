// Report body sanitizer (Section 6): allow-list of the formats the editor can produce.
// Used before insert (consultant) and again before rendering (dashboard, PDF).
// Requires the DOMPurify global (loaded from the CDN in the page).

const TAGS = ['p', 'br', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 'span', 'ol', 'ul', 'li'];
const ATTRS = ['class', 'style', 'dir'];
const CLASS_OK = /^ql-(size-(small|large|huge)|direction-rtl|align-(center|right|justify)|indent-[1-8])$/;
// Lists take one direction from their first item, so numbers stay next to every item.
const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'OL', 'UL']);

let hooked = false;
function installHooks() {
  if (hooked) return;
  hooked = true;
  window.DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'class') {
      data.attrValue = data.attrValue.split(/\s+/).filter((c) => CLASS_OK.test(c)).join(' ');
      if (!data.attrValue) data.keepAttr = false;
    } else if (data.attrName === 'style') {
      // Only text colour survives (the one inline style the editor writes).
      const m = /(?:^|;)\s*color\s*:\s*(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))/i.exec(data.attrValue);
      if (m) data.attrValue = `color: ${m[1]}`;
      else data.keepAttr = false;
    } else if (data.attrName === 'dir') {
      if (!['auto', 'rtl', 'ltr'].includes(data.attrValue)) data.keepAttr = false;
    }
  });
  window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // Per-paragraph automatic direction so Arabic and English lines each read correctly.
    if (BLOCKS.has(node.nodeName) && !node.hasAttribute('dir')) node.setAttribute('dir', 'auto');
    if (node.nodeName === 'LI') node.removeAttribute('dir');
  });
}

export function sanitizeReportHtml(html) {
  installHooks();
  return window.DOMPurify.sanitize(String(html ?? '').replace(/&nbsp;/g, ' '), {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRS,
    ALLOW_DATA_ATTR: false,
  });
}
