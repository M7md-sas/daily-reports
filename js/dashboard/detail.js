// Report detail (Section 8.3): the PDF card layout, with photos via short-lived signed URLs.
import { CONFIG } from '../config.js?v=4';
import { t, getLang } from '../i18n.js?v=4';
import { el } from '../lib.js?v=4';
import { FULL_COLS } from '../export/data.js?v=4';
import { sortedPhotos } from '../export/excel.js?v=4';
import { buildCard } from '../export/card.js?v=4';
import { loadingBlock, errorBlock } from './ui.js?v=4';

export async function render(ctx, view, [id], isCurrent) {
  const back = el('a', { class: 'btn sm', href: '#reports', text: `← ${t('rd.back')}` });
  view.replaceChildren(el('div', { class: 'detail' }, back, loadingBlock()));
  const box = view.firstChild;

  const { data: r, error } = await ctx.sb.from('reports').select(FULL_COLS).eq('id', id).maybeSingle();
  if (!isCurrent()) return;
  if (error) {
    box.lastChild.replaceWith(errorBlock(t('err.load'), () => render(ctx, view, [id], isCurrent)));
    return;
  }
  if (!r) {
    box.lastChild.replaceWith(el('p', { class: 'center-state', text: t('rd.notFound') }));
    return;
  }

  const paths = sortedPhotos(r).map((p) => p.storage_path);
  let urls = [];
  if (paths.length) {
    const signed = await ctx.sb.storage.from(CONFIG.PHOTO_BUCKET).createSignedUrls(paths, 3600);
    if (!isCurrent()) return;
    urls = (signed.data ?? []).map((s) => s.signedUrl).filter(Boolean);
  }
  const photos = urls.map((src) => ({ src, onClick: () => ctx.openLightbox(src) }));
  box.lastChild.replaceWith(buildCard(r, { photos, lang: getLang() }));
}
