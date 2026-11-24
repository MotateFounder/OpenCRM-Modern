// Round picture with initials fallback (v1 look: circular photo with soft shadow).
import { h, initials, hashColor, pictureSrc } from './dom.js';
import { recordTitle } from './shared.js';

export function avatar(type, rec, size = 40) {
  const title = recordTitle(type, rec);
  const src = type.pictureField ? pictureSrc(rec[type.pictureField]) : '';
  const fallback = () => h('div', { class: 'avatar avatar-initials', style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px`, background: hashColor(title) } }, initials(title));
  if (!src) return fallback();
  const img = h('img', { class: 'avatar', src, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy', style: { width: `${size}px`, height: `${size}px` } });
  img.addEventListener('error', () => img.replaceWith(fallback()));
  return img;
}
