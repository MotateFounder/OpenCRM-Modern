// Settings → Email → Open & click tracking (guided setup for Cloudflare or PHP), rules editor,
// compose toggle and small status badges.
import { h, replace } from './dom.js';
import { store, mutate, emit } from './store.js';
import { newId } from './shared.js';
import { openModal, toast, field, confirmDialog } from './ui.js';
import { RULE_EVENTS, INTENTS } from './mail-rules.js';

const tcfg = () => store.config.mail?.tracker || { kind: 'off' };
export const trackerConfigured = () => { const c = tcfg(); return c.kind && c.kind !== 'off' && !!c.url && !!c.hasSecret; };

async function saveCfg(patch) {
  const r = await window.crm.mail.tracker({ action: 'save', cfg: { ...tcfg(), ...patch } });
  const res = await window.crm.config.update({});
  store.config = res.config;
  emit('config-changed');
  return r;
}

export function openTrackingSettings() {
  const body = h('div', { class: 'track-settings' });
  const result = h('div', { class: 'test-result' });
  const render = () => {
    const c = tcfg();
    const kind = c.kind || 'off';
    const radio = (v, label, hint) => h('label', { class: ['track-kind', kind === v && 'on'] },
      h('input', { type: 'radio', name: 'tk', checked: kind === v, onchange: async () => { await saveCfg({ kind: v }); render(); } }),
      h('div', {}, h('b', {}, label), h('div', { class: 'muted small' }, hint)));
    const url = h('input', { class: 'input', value: c.url || '', placeholder: kind === 'php' ? 'https://yourdomain.com/t/tracker.php' : 'https://opencrm-tracker.<you>.workers.dev' });
    url.addEventListener('change', async () => { await saveCfg({ url: url.value.trim().replace(/\/+$/, '') }); render(); });
    const secretRow = h('div', { class: 'row-gap' },
      c.hasSecret ? h('span', { class: 'ok' }, '✓ Secret created') : h('span', { class: 'muted' }, 'No secret yet'),
      h('button', { class: 'btn btn-sm', onclick: async () => {
        if (c.hasSecret && !(await confirmDialog('Create a new secret? The tracker must then be updated with the new one.', { okLabel: 'New secret' }))) return;
        await window.crm.mail.tracker({ action: 'newSecret' }); await saveCfg({}); render(); toast('Secret created — copy it into the tracker');
      } }, c.hasSecret ? 'New secret…' : 'Create secret'),
      c.hasSecret ? h('button', { class: 'btn btn-sm', onclick: async () => { const r = await window.crm.mail.tracker({ action: 'secret' }); await window.crm.app.clipboard(r.secret); toast('Secret copied'); } }, '📋 Copy secret') : null);
    const steps = kind === 'cloudflare' ? h('ol', { class: 'track-steps' },
      h('li', {}, 'Create a free account at ', h('a', { href: 'https://dash.cloudflare.com/sign-up', class: 'ext' }, 'dash.cloudflare.com'), '.'),
      h('li', {}, 'Workers & Pages → Create → “Create Worker” → name it e.g. ', h('code', {}, 'opencrm-tracker'), ' → Deploy → Edit code → replace everything with the tracker code ',
        h('button', { class: 'btn btn-sm', onclick: async () => { const r = await window.crm.mail.tracker({ action: 'code', kind: 'cloudflare' }); await window.crm.app.clipboard(r.code); toast('Tracker code copied'); } }, '📋 Copy tracker code'), ' → Deploy.'),
      h('li', {}, 'Storage & Databases → D1 → Create database ', h('code', {}, 'opencrm-tracker'), '. Then in your worker: Settings → Bindings → Add → D1 database, variable name ', h('code', {}, 'DB'), '.'),
      h('li', {}, 'Settings → Variables and Secrets → Add → type Secret, name ', h('code', {}, 'SECRET'), ', value: your secret ', secretRow),
      h('li', {}, 'Copy the worker address (shown at the top, ends in .workers.dev) here:', url),
      h('li', {}, 'Optional, better for spam filters: Settings → Domains & Routes → add a domain you own, like ', h('code', {}, 't.yourdomain.com'), ', and use that address above.'))
      : kind === 'php' ? h('ol', { class: 'track-steps' },
        h('li', {}, 'Create the secret: ', secretRow),
        h('li', {}, h('button', { class: 'btn btn-sm', disabled: !c.hasSecret, onclick: () => window.crm.mail.tracker({ action: 'savePhp' }) }, '💾 Save tracker.php…'), ' (the secret is already inside).'),
        h('li', {}, 'Upload it to your website, e.g. into a folder ', h('code', {}, '/t/'), ' with your host’s File Manager or FTP. It needs PHP 7.4 or newer (almost every host has it).'),
        h('li', {}, 'Paste its address here:', url))
        : h('p', { class: 'muted' }, 'Tracking is off. Interest buttons still work: they open a ready-made reply. Replies are still read by the AI.');
    const opt = (key, label, def = true) => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: c[key] ?? def, onchange: e => saveCfg({ [key]: e.target.checked }) }), ` ${label}`);
    replace(body,
      h('p', {}, 'See when contacts ', h('b', {}, 'open'), ' an email, ', h('b', {}, 'click'), ' a link or press an ', h('b', {}, 'interest button'), ' (“Yes, tell me more”). Emails point to a tiny tracker that ', h('b', {}, 'you'), ' own; it only stores random codes and times — never names or addresses.'),
      h('div', { class: 'track-kinds' },
        radio('off', 'Off', 'No tracking.'),
        radio('cloudflare', 'Cloudflare Worker (recommended)', 'Free: 100,000 requests a day. ~10 minutes to set up.'),
        radio('php', 'My own web host (PHP)', 'Upload one file to a site you already have.')),
      steps,
      kind !== 'off' ? h('div', {},
        h('h3', {}, 'Options'),
        opt('pixel', 'Count opens (a tiny invisible picture). Off = only clicks and interest buttons, no tracking picture.'),
        opt('clicks', 'Count link clicks'),
        opt('defaultOn', 'Track new emails by default (you can switch it off in each email)'),
        h('div', { class: 'row-gap' },
          h('button', { class: 'btn btn-primary', onclick: async () => {
            replace(result, h('span', { class: 'muted' }, 'Testing…'));
            try { const r = await window.crm.mail.tracker({ action: 'test' }); replace(result, h('span', { class: 'ok' }, `✓ Tracker works (storage: ${r.storage}).`)); } catch (e) { replace(result, h('span', { class: 'err' }, `✗ ${e.message}`)); }
          } }, 'Test tracker'),
          h('button', { class: 'btn', onclick: async () => { const r = await window.crm.mail.tracker({ action: 'check' }); toast(r.error ? r.error : `Checked: ${r.total || 0} new event(s)`); } }, 'Check now')),
        result) : null,
      h('details', { class: 'help-details' }, h('summary', {}, 'Privacy & law (EU / Spain)'),
        h('p', { class: 'small' }, 'In the EU, tracking pictures in marketing emails can require the recipient’s consent (ePrivacy / GDPR). For one-to-one business emails a legitimate interest may apply. If unsure, untick “Count opens”: clicks and interest buttons are what the person chooses to do.'),
        h('p', { class: 'small' }, 'Opens are approximate: Apple Mail loads pictures automatically (shown as “privacy proxy”), and many mail apps block pictures. Clicks, interest buttons and replies are reliable.')),
      h('h3', {}, 'Automatic actions'),
      rulesEditor());
  };
  render();
  openModal({ title: '📊 Open & click tracking', size: 'lg', body });
}

function rulesEditor() {
  const box = h('div', { class: 'rules' });
  const type = store.data.meta.recordTypes[0];
  const fields = type.fieldDefs.filter(f => ['text', 'select', 'tags', 'checkbox', 'multiselect'].includes(f.type));
  const upd = (label, fn) => mutate(label, d => { d.meta.mailRules ||= []; fn(d.meta.mailRules); }, { coalesce: `rules:${label}`, undoable: false });
  const paint = () => {
    const rules = store.data.meta.mailRules || [];
    replace(box,
      h('p', { class: 'muted small' }, 'Always: a note is added for interest clicks, interested replies and unsubscribes; unsubscribes set “Do not email”; bounces mark the address invalid.'),
      ...rules.map((r, i) => {
        const matchOpts = r.on === 'reply' ? INTENTS : r.on === 'interest' ? [['interested', 'interested'], ['call', 'call'], ['accept', 'accept'], ['questions', 'questions'], ['not-now', 'not-now']] : [];
        return h('div', { class: 'rule-row' },
          h('span', {}, 'When someone'),
          h('select', { class: 'input input-sm', onchange: e => { upd('Rule', l => { l[i].on = e.target.value; l[i].match = ''; }); paint(); } }, RULE_EVENTS.map(([v, l]) => h('option', { value: v, selected: r.on === v }, l))),
          matchOpts.length ? h('select', { class: 'input input-sm', title: 'Which answer', onchange: e => upd('Rule', l => { l[i].match = e.target.value; }) }, h('option', { value: '' }, '(any)'), matchOpts.map(([v, l]) => h('option', { value: v, selected: r.match === v }, l))) : null,
          h('span', {}, '→'),
          h('select', { class: 'input input-sm', onchange: e => { upd('Rule', l => { l[i].action = e.target.value; }); paint(); } },
            [['setField', 'set field'], ['addLabel', 'add label'], ['reminder', 'set a reminder in'], ['notify', 'show a message']].map(([v, l]) => h('option', { value: v, selected: r.action === v }, l))),
          r.action === 'setField' ? h('select', { class: 'input input-sm', onchange: e => upd('Rule', l => { l[i].field = e.target.value; }) }, fields.map(f => h('option', { value: f.key, selected: r.field === f.key }, f.label))) : null,
          r.action === 'reminder' ? h('input', { class: 'input input-sm', type: 'number', min: 0, value: r.days ?? 2, style: { width: '60px' }, title: 'days', onchange: e => upd('Rule', l => { l[i].days = +e.target.value; }) }) : null,
          r.action === 'reminder' ? h('span', {}, 'days') : null,
          h('input', { class: 'input input-sm', value: r.value || '', placeholder: r.action === 'setField' ? 'value, e.g. Interested' : r.action === 'addLabel' ? 'label' : 'text', onchange: e => upd('Rule', l => { l[i].value = e.target.value; }) }),
          h('button', { class: 'icon-btn', title: 'Delete rule', onclick: () => { upd('Delete rule', l => l.splice(i, 1)); paint(); } }, '×'));
      }),
      h('button', { class: 'btn-link small', onclick: () => {
        const stage = fields.find(f => /stage|status|estado/i.test(f.label));
        upd('Add rule', l => l.push({ id: newId('r'), on: 'interest', match: '', action: stage ? 'setField' : 'addLabel', field: stage?.key || '', value: stage ? 'Interested' : 'interested' }));
        paint();
      } }, '+ Add rule'));
  };
  paint();
  return box;
}

/** Checkbox in the compose window. Writes d.tracking = 'on' | 'off'. */
export function trackingToggle(d) {
  if (!trackerConfigured()) return null;
  if (!d.tracking) d.tracking = tcfg().defaultOn === false ? 'off' : 'on';
  return h('label', { class: 'check-row small', title: 'See when this email is opened and links or interest buttons are clicked' },
    h('input', { type: 'checkbox', dataset: { track: '1' }, checked: d.tracking === 'on', onchange: e => { d.tracking = e.target.checked ? 'on' : 'off'; } }), ' 📊 Track');
}

export function trackingMini(m) {
  const t = m.trackingState;
  if (!t) return null;
  return h('span', { class: ['track-badge', `ts-${t.status}`], title: t.title || '' }, t.label);
}
