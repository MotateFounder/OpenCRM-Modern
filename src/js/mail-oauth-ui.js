// "Sign in with Microsoft / Google" for mail accounts + the one-time Client ID setup.
import { h, replace } from './dom.js';
import { store, emit } from './store.js';
import { toast, field } from './ui.js';

const ocfg = () => store.config.mail?.oauth || {};

async function saveOauth(patch) {
  const res = await window.crm.config.update({ mail: { oauth: { ...ocfg(), ...patch } } });
  store.config = res.config;
  emit('config-changed');
}

export function microsoftGuide() {
  return h('details', { class: 'help-details', open: !ocfg().microsoftClientId },
    h('summary', {}, 'How to get a Microsoft Client ID (once, about 5 minutes, free)'),
    h('ol', { class: 'track-steps' },
      h('li', {}, 'Open ', h('a', { href: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', class: 'ext' }, 'Microsoft Entra → App registrations'), ' and sign in with your Microsoft account. If it asks you to create a directory / free Azure account, the free tier is enough.'),
      h('li', {}, '“New registration” → Name: ', h('code', {}, 'OpenCRM'), ' → Supported account types: “Personal Microsoft accounts only” (or “any organizational directory and personal accounts” to also use work accounts).'),
      h('li', {}, 'Redirect URI: platform “Public client/native (mobile & desktop)”, value ', h('code', {}, 'http://localhost'), ' → Register.'),
      h('li', {}, 'Authentication → “Allow public client flows” → Yes → Save.'),
      h('li', {}, 'Copy the “Application (client) ID” and paste it below.')));
}

export function oauthClientSettings() {
  const ms = h('input', { class: 'input', value: ocfg().microsoftClientId || '', placeholder: 'Application (client) ID, e.g. 1a2b3c4d-…' });
  ms.addEventListener('change', () => saveOauth({ microsoftClientId: ms.value.trim() }).then(() => toast('Microsoft Client ID saved')));
  const tenant = h('select', { class: 'input input-sm', onchange: e => saveOauth({ microsoftTenant: e.target.value }) },
    [['consumers', 'Personal accounts (Outlook.com, Hotmail, Live)'], ['common', 'Personal and work/school accounts'], ['organizations', 'Work/school accounts only']].map(([v, l]) => h('option', { value: v, selected: (ocfg().microsoftTenant || 'consumers') === v }, l)));
  const gid = h('input', { class: 'input', value: ocfg().googleClientId || '', placeholder: 'xxxx.apps.googleusercontent.com' });
  const gsec = h('input', { class: 'input', type: 'password', value: ocfg().googleClientSecret || '', placeholder: 'Client secret of the Desktop client' });
  gid.addEventListener('change', () => saveOauth({ googleClientId: gid.value.trim() }));
  gsec.addEventListener('change', () => saveOauth({ googleClientSecret: gsec.value.trim() }));
  return h('div', {},
    h('h4', {}, 'Microsoft (Outlook.com / Hotmail / Live)'),
    microsoftGuide(),
    h('div', { class: 'two-col' }, field('Client ID', ms), field('Accounts', tenant)),
    h('h4', {}, 'Google (optional — an app password is simpler)'),
    h('details', { class: 'help-details' }, h('summary', {}, 'How to get a Google Client ID'),
      h('ol', { class: 'track-steps' },
        h('li', {}, h('a', { href: 'https://console.cloud.google.com/projectcreate', class: 'ext' }, 'Google Cloud console'), ' → create a project → APIs & Services → OAuth consent screen: External, add your address as a test user.'),
        h('li', {}, 'Credentials → Create credentials → OAuth client ID → Application type “Desktop app”. Copy the Client ID and Client secret below.'),
        h('li', {}, 'Note: while the consent screen is in “Testing”, Google asks you to sign in again every 7 days. An app password does not have that limit.'))),
    h('div', { class: 'two-col' }, field('Client ID', gid), field('Client secret', gsec)));
}

/** Button shown in the account form for providers that need OAuth. */
export function oauthButton(preset, collect, save, provider = preset.auth === 'oauth-google' ? 'google' : 'microsoft') {
  const box = h('div', { class: 'oauth-box' });
  const label = provider === 'google' ? 'Google' : 'Microsoft';
  const paint = () => {
    const id = provider === 'google' ? ocfg().googleClientId : ocfg().microsoftClientId;
    if (!id) {
      const inp = h('input', { class: 'input', placeholder: `${label} Client ID` });
      replace(box,
        provider === 'microsoft' ? microsoftGuide() : h('p', { class: 'small' }, 'Add your Google Client ID in Settings → Email → Sign-in apps.'),
        provider === 'microsoft' ? h('div', { class: 'row-gap' }, inp, h('button', { class: 'btn btn-sm', onclick: async () => { if (!inp.value.trim()) return; await saveOauth({ microsoftClientId: inp.value.trim() }); paint(); } }, 'Save Client ID')) : null);
      return;
    }
    replace(box, h('button', { class: 'btn btn-primary oauth-btn', onclick: async e => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = `Waiting for ${label} sign-in in your browser…`;
      try {
        const acc = collect();
        const r = await window.crm.mail.oauth({ provider, accountId: acc.id, loginHint: acc.email });
        await save({ ...acc, id: r.accountId, email: acc.email || r.email, auth: provider === 'google' ? 'oauth-google' : 'oauth-microsoft', imap: { ...acc.imap, user: acc.imap.user || r.email }, smtp: { ...acc.smtp, user: acc.smtp.user || r.email } });
        toast(`Signed in as ${r.email || acc.email}`);
        document.querySelector('.acct-form')?.closest('.modal')?.querySelector('.modal-x')?.click();
      } catch (err) { toast(err.message, { type: 'error', timeout: 9000 }); }
      finally { btn.disabled = false; btn.textContent = `Sign in with ${label}`; }
    } }, `Sign in with ${label}`), h('span', { class: 'muted small' }, ' Your password is never seen by OpenCRM; you can revoke access any time in your account settings.'));
  };
  paint();
  return box;
}
