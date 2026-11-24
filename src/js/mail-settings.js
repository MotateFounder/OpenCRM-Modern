// Settings → Email: accounts (presets, app-password help, test), sync options, privacy, templates.
import { h, replace } from './dom.js';
import { store, mutate, emit, on } from './store.js';
import { field, toast, confirmDialog, openModal } from './ui.js';
import { mail, refreshMail, accountStatus } from './mail-state.js';
import { hooks } from './hooks.js';
import { oauthButton, oauthClientSettings } from './mail-oauth-ui.js';

const SECURITY = [['tls', 'SSL/TLS'], ['starttls', 'STARTTLS'], ['none', 'None (insecure)']];

async function updateMailConfig(patch) {
  const res = await window.crm.config.update({ mail: patch });
  store.config = res.config;
  emit('config-changed');
}

export function mailSettingsPane(pane) {
  const accountsBox = h('div', { class: 'acct-list' });
  const renderAccounts = () => {
    replace(accountsBox, 
      ...mail.accounts.map(a => {
        const s = accountStatus(a.id);
        const dot = { online: 'ok', syncing: 'ok', connecting: 'warn', offline: 'warn', error: 'err' }[s.state] || 'off';
        return h('div', { class: 'acct-row' },
          h('span', { class: ['status-dot', dot], title: s.state }),
          h('div', { class: 'acct-main' },
            h('b', {}, a.email), a.fromName ? h('span', { class: 'muted' }, ` · ${a.fromName}`) : null,
            h('div', { class: 'muted small' }, s.error || ({ online: `Connected${s.lastSync ? ` · checked ${new Date(s.lastSync).toLocaleTimeString()}` : ''}`, syncing: 'Checking for mail…', connecting: 'Connecting…', offline: 'Offline — retrying automatically', stopped: a.enabled === false ? 'Paused' : 'Not connected' }[s.state] || s.state))),
          h('button', { class: 'btn btn-sm', onclick: () => window.crm.mail.syncNow(a.id).then(r => { if (r.errors?.length) toast(r.errors[0], { type: 'error' }); else toast('Up to date'); }) }, 'Check now'),
          h('button', { class: 'btn btn-sm', onclick: () => accountForm(a, renderAccounts) }, 'Edit'),
          h('button', { class: 'icon-btn danger', title: 'Remove account', onclick: async () => {
            if (!(await confirmDialog(`Remove ${a.email} from OpenCRM?`, { danger: true, okLabel: 'Remove', detail: 'Nothing is deleted from your mailbox. Downloaded copies in OpenCRM are removed.' }))) return;
            await window.crm.mail.removeAccount(a.id); await refreshMail(); renderAccounts();
          } }, '🗑'));
      }),
      h('button', { class: 'btn btn-primary', onclick: () => accountForm(null, renderAccounts) }, '+ Add email account'));
  };
  renderAccounts();
  const offs = [];
  const onStatus = () => { if (!accountsBox.isConnected) { offs.forEach(o => o()); return; } renderAccounts(); };
  offs.push(on('mail-status', onStatus), on('mail-changed', onStatus));

  const s = store.data.meta.settings.mail || {};
  const setS = (label, fn) => mutate(label, d => fn(d.meta.settings.mail), { coalesce: `mailsettings:${label}`, undoable: false });
  const cfg = store.config.mail || {};
  pane.append(
    h('p', { class: 'muted' }, 'Send and receive email with any provider that offers IMAP and SMTP. Passwords are stored encrypted with Windows and never leave this computer, except to sign in to your own mail server.'),
    h('h3', {}, 'Accounts'), accountsBox,
    h('h3', {}, 'What to download (this database)'),
    field('Keep', h('select', { class: 'input', onchange: e => setS('Mail scope', m => { m.scope = e.target.value; }) },
      h('option', { value: 'contacts', selected: s.scope !== 'all' }, 'Emails with people in this CRM (recommended) — others show as headers only'),
      h('option', { value: 'all', selected: s.scope === 'all' }, 'All emails in the Inbox and Sent folders'))),
    field('From the last', h('select', { class: 'input input-sm', onchange: e => setS('Mail days', m => { m.days = +e.target.value; }) },
      [[30, '30 days'], [90, '3 months'], [365, '12 months'], [730, '2 years'], [1825, '5 years']].map(([v, l]) => h('option', { value: v, selected: (s.days || 365) === v }, l))), 'Applies to the first download of each account. New mail always arrives.'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!s.includeInSearch, onchange: e => { setS('Mail in search', m => { m.includeInSearch = e.target.checked; }); import('./mail-state.js').then(x => x.refreshSearchText()); } }), ' Include email subjects and previews in search (normal and ✨ AI search)'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: s.intentDetection !== false, onchange: e => setS('Reply intent', m => { m.intentDetection = e.target.checked; }) }), ' ✨ Let the local AI read new replies and tag them (interested, question, out of office…)'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: s.lastContactIncludesEmail !== false, onchange: e => setS('Last contact', m => { m.lastContactIncludesEmail = e.target.checked; }) }), ' Emails count as contact for the “Date” (last contact) column'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: s.images === 'always', onchange: e => setS('Mail images', m => { m.images = e.target.checked ? 'always' : 'ask'; }) }), ' Always show pictures from the internet in emails (not recommended: senders can see that you opened their email)'),
    s.allowImagesFrom?.length ? h('div', { class: 'small muted' }, `Pictures always shown from: ${s.allowImagesFrom.join(', ')} `, h('button', { class: 'btn-link small', onclick: () => setS('Mail images', m => { m.allowImagesFrom = []; }) }, 'Clear')) : null,
    h('h3', {}, 'This computer'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: cfg.notifyNewMail !== false, onchange: e => updateMailConfig({ notifyNewMail: e.target.checked }) }), ' Windows notification when a contact emails you'),
    field('Undo send', h('select', { class: 'input input-sm', onchange: e => updateMailConfig({ undoSeconds: +e.target.value }) },
      [[0, 'Off'], [5, '5 seconds'], [10, '10 seconds'], [20, '20 seconds'], [30, '30 seconds']].map(([v, l]) => h('option', { value: v, selected: (cfg.undoSeconds ?? 10) === v }, l)))),
    field('Check for new mail every', h('select', { class: 'input input-sm', onchange: e => updateMailConfig({ pollMinutes: +e.target.value }) },
      [[2, '2 minutes'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes']].map(([v, l]) => h('option', { value: v, selected: (cfg.pollMinutes || 5) === v }, l))), 'New mail usually arrives instantly (IMAP IDLE); this is the fallback.'),
    h('h3', {}, 'Sign-in apps (Outlook.com, optional Google)'),
    h('details', { class: 'help-details' }, h('summary', {}, 'Client IDs for “Sign in with Microsoft / Google”'), oauthClientSettings()),
    h('h3', {}, 'Templates & design'),
    h('div', { class: 'row-gap' },
      h('button', { class: 'btn', onclick: () => hooks.openMailTemplates?.() }, '📋 Email templates…'),
      hooks.openBrandKit ? h('button', { class: 'btn', onclick: () => hooks.openBrandKit() }, '🎨 Brand kit…') : null,
      hooks.openTrackingSettings ? h('button', { class: 'btn', onclick: () => hooks.openTrackingSettings() }, '📊 Open & click tracking…') : null),
  );
}

/** Add / edit account dialog. */
export async function accountForm(existing, done) {
  const { presets } = await window.crm.mail.presets();
  const a = structuredClone(existing || { email: '', fromName: store.config.ui.me?.name || '', preset: 'custom', imap: { host: '', port: 993, security: 'tls', user: '' }, smtp: { host: '', port: 465, security: 'tls', user: '' }, auth: 'password', signature: '' });
  const email = h('input', { class: 'input', type: 'email', value: a.email, placeholder: 'you@example.com', autofocus: !existing });
  const fromName = h('input', { class: 'input', value: a.fromName || '', placeholder: 'Your name as recipients see it' });
  const presetSel = h('select', { class: 'input' }, presets.map(p => h('option', { value: p.id, selected: p.id === a.preset }, p.label)));
  const pass = h('input', { class: 'input', type: 'password', placeholder: existing?.hasSecret ? '•••••••• (saved — type to replace)' : 'App password or mailbox password', autocomplete: 'new-password' });
  const help = h('div', { class: 'preset-help' });
  let authChoice = a.auth || 'password';
  const authSel = h('select', { class: 'input input-sm' }, h('option', { value: 'password', selected: authChoice === 'password' }, 'App password (simplest)'), h('option', { value: 'oauth-google', selected: authChoice === 'oauth-google' }, 'Sign in with Google (needs your own Client ID)'));
  const authRow = field('Sign-in method', authSel);
  const mk = (srv) => ({
    host: h('input', { class: 'input', value: a[srv].host }),
    port: h('input', { class: 'input input-sm', type: 'number', value: a[srv].port }),
    security: h('select', { class: 'input input-sm' }, SECURITY.map(([v, l]) => h('option', { value: v, selected: a[srv].security === v }, l))),
    user: h('input', { class: 'input', value: a[srv].user || '', placeholder: 'usually your email address' }),
  });
  const imap = mk('imap'), smtp = mk('smtp');
  const selfSigned = h('input', { type: 'checkbox', checked: !!a.allowSelfSigned });
  const sentFolder = h('input', { class: 'input input-sm', value: a.sentFolder || '', placeholder: 'auto-detect' });
  const dailyLimit = h('input', { class: 'input input-sm', type: 'number', min: 1, value: a.dailyLimit || '' });
  const signature = h('textarea', { class: 'input', rows: 3, value: a.signature || '', placeholder: 'Signature (Markdown). Blank = the signature from Settings → General.' });
  const result = h('div', { class: 'test-result' });
  const adv = h('details', { class: 'help-details', open: a.preset === 'custom' }, h('summary', {}, 'Server settings'),
    h('div', { class: 'srv-grid' },
      h('b', {}, 'Incoming (IMAP)'), h('span', {}), h('span', {}), h('span', {}),
      field('Server', imap.host), field('Port', imap.port), field('Security', imap.security), field('User name', imap.user),
      h('b', {}, 'Outgoing (SMTP)'), h('span', {}), h('span', {}), h('span', {}),
      field('Server', smtp.host), field('Port', smtp.port), field('Security', smtp.security), field('User name', smtp.user)),
    h('label', { class: 'check-row' }, selfSigned, ' Allow self-signed certificate (only for your own server)'),
    h('div', { class: 'two-col' }, field('Sent folder', sentFolder), field('Max emails per day (bulk send)', dailyLimit)));

  const applyPreset = (id, fromEmail = false) => {
    const p = presets.find(x => x.id === id) || presets.find(x => x.id === 'custom');
    if (p.id !== 'custom' || fromEmail) {
      imap.host.value = p.imap.host || imap.host.value; imap.port.value = p.imap.port; imap.security.value = p.imap.security;
      smtp.host.value = p.smtp.host || smtp.host.value; smtp.port.value = p.smtp.port; smtp.security.value = p.smtp.security;
    }
    if (!dailyLimit.value) dailyLimit.placeholder = String(p.dailyLimit);
    replace(help, );
    const div = h('div', { class: ['preset-note', p.auth.startsWith('oauth') && 'warn'] });
    div.innerHTML = p.help; // static text from presets.js (no user data)
    help.append(div);
    if (p.helpUrl) help.append(h('a', { href: p.helpUrl, class: 'ext small' }, 'Open the page ↗'));
    if (p.id !== 'gmail' && authChoice === 'oauth-google') authChoice = p.auth;
    if (p.auth.startsWith('oauth')) authChoice = p.auth;
    else if (p.id !== 'gmail') authChoice = 'password';
    authRow.classList.toggle('hidden', p.id !== 'gmail');
    authSel.value = authChoice === 'oauth-google' ? 'oauth-google' : 'password';
    pass.closest('.form-row')?.classList.toggle('hidden', authChoice.startsWith('oauth'));
    if (authChoice.startsWith('oauth')) help.append(oauthButton({ ...p, auth: authChoice }, collect, async acc => { await save(acc); }));
    adv.open = p.id === 'custom';
  };
  email.addEventListener('change', async () => {
    const g = await window.crm.mail.guess(email.value.trim());
    if (!imap.user.value || imap.user.value === a.email) imap.user.value = email.value.trim();
    if (!smtp.user.value || smtp.user.value === a.email) smtp.user.value = email.value.trim();
    a.email = email.value.trim();
    if (!existing) {
      presetSel.value = g.preset;
      if (g.preset === 'custom') { imap.host.value = g.imap.host; smtp.host.value = g.smtp.host; }
      applyPreset(g.preset, true);
    }
  });
  presetSel.addEventListener('change', () => applyPreset(presetSel.value, true));
  authSel.addEventListener('change', () => { authChoice = authSel.value; applyPreset(presetSel.value, false); });

  const collect = () => ({
    ...a,
    email: email.value.trim(), fromName: fromName.value.trim(), preset: presetSel.value,
    auth: authChoice,
    imap: { host: imap.host.value.trim(), port: +imap.port.value, security: imap.security.value, user: imap.user.value.trim() || email.value.trim() },
    smtp: { host: smtp.host.value.trim(), port: +smtp.port.value, security: smtp.security.value, user: smtp.user.value.trim() || email.value.trim() },
    allowSelfSigned: selfSigned.checked, sentFolder: sentFolder.value.trim(), dailyLimit: +dailyLimit.value || 0, signature: signature.value,
  });

  const test = async () => {
    const acc = collect();
    if (!acc.email || !acc.imap.host || !acc.smtp.host) { replace(result, h('span', { class: 'err' }, 'Enter the email address and server names first.')); return null; }
    if (!pass.value && !existing?.hasSecret && acc.auth === 'password') { replace(result, h('span', { class: 'err' }, 'Enter the password.')); return null; }
    if (acc.auth.startsWith('oauth') && !existing?.hasSecret) { replace(result, h('span', { class: 'err' }, 'Press “Sign in with …” first.')); return null; }
    replace(result, h('span', { class: 'muted' }, 'Testing… (this can take up to 20 seconds)'));
    try {
      const r = await window.crm.mail.testAccount({ account: acc, password: pass.value || null });
      replace(result, 
        h('div', { class: r.imap.ok ? 'ok' : 'err' }, r.imap.ok ? `✓ Receiving (IMAP) works${r.imap.sent ? ` · Sent folder: ${r.imap.sent}` : ''}` : `✗ ${r.imap.error}`),
        h('div', { class: r.smtp.ok ? 'ok' : 'err' }, r.smtp.ok ? '✓ Sending (SMTP) works' : `✗ ${r.smtp.error}`));
      return r;
    } catch (e) { replace(result, h('span', { class: 'err' }, e.message)); return null; }
  };

  const save = async (accOverride) => {
    const acc = accOverride || collect();
    if (!acc.email) { toast('Enter the email address.', { type: 'error' }); return false; }
    const r = await window.crm.mail.saveAccount({ account: acc, password: pass.value || null });
    a.id = r.account.id;
    await refreshMail();
    done?.();
    toast(`${acc.email} saved. Checking for mail…`);
    return true;
  };

  openModal({
    title: existing ? `Email account — ${existing.email}` : 'Add email account', size: 'lg',
    body: h('div', { class: 'acct-form' },
      h('div', { class: 'two-col' }, field('Email address', email), field('Your name', fromName)),
      field('Provider', presetSel),
      authRow,
      help,
      field('Password', pass, 'Stored encrypted on this computer (Windows DPAPI).'),
      adv,
      field('Signature', signature),
      result),
    actions: [
      { label: 'Cancel' },
      'spacer',
      { label: 'Test connection', keepOpen: true, fn: async () => { await test(); return false; } },
      { label: 'Save', primary: true, keepOpen: true, fn: async api => {
        const r = await test();
        if (!r) return false;
        if (!r.imap.ok || !r.smtp.ok) {
          if (!(await confirmDialog('The connection test failed. Save the account anyway?', { okLabel: 'Save anyway' }))) return false;
        }
        if (await save()) api.close();
        return false;
      } },
    ],
  });
  applyPreset(a.preset);
}
