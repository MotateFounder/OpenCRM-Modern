// Starter templates (field registries) and starter prompts.
import { defaultBrand, defaultMailSettings, starterEmailTemplates } from './email-templates.js';
// A template only pre-fills the schema; everything stays editable afterwards.

import { emptyDatabase, makeGenericType, COLOR_PALETTE, newId } from './schema.js';

const opts = (...values) => values.map((v, i) => ({ value: v, color: COLOR_PALETTE[(i * 2 + 1) % COLOR_PALETTE.length] }));

const STAGE_COLORS = ['#9e9e9e', '#42a5f5', '#26c6da', '#ffa726', '#ab47bc', '#66bb6a', '#ef5350'];
const stageOpts = (...values) => values.map((v, i) => ({ value: v, color: STAGE_COLORS[i % STAGE_COLORS.length] }));

export const TEMPLATES = [
  {
    key: 'blank',
    label: 'Blank',
    description: 'Only the built-in contact fields (Name, Groups, Location, URL, Email, Phone, Labels, Info).',
    apply() {},
  },
  {
    key: 'recruitment',
    label: 'Recruitment',
    description: 'Candidate pipeline: Stage dropdown, Resume (markdown), availability, salary, and a Positions record type.',
    apply(db) {
      const c = db.meta.recordTypes[0];
      c.fieldDefs.push(
        { key: 'stage', label: 'Stage', type: 'select', options: stageOpts('Sourced', 'Contacted', 'Interested', 'Interview', 'Offer', 'Placed', 'Rejected'), default: 'Sourced', showInTable: true, showInCard: true, aiContext: true },
        { key: 'resume', label: 'Resume', type: 'markdown', showInTable: false, showInCard: true, aiContext: true },
        { key: 'availability', label: 'Availability', type: 'text', showInTable: false, showInCard: true, aiContext: true },
        { key: 'salaryExpectation', label: 'Salary expectation', type: 'text', showInTable: false, showInCard: true, aiContext: true },
        { key: 'cvFiles', label: 'CV files', type: 'file', showInTable: false, showInCard: true, aiContext: false },
      );
      c.ui.columns.splice(1, 0, 'stage');
      const p = makeGenericType('positions', 'Positions', 'Position');
      p.fieldDefs.push(
        { key: 'client', label: 'Client', type: 'text', showInTable: true, showInCard: true, aiContext: true },
        { key: 'status', label: 'Status', type: 'select', options: stageOpts('Open', 'On hold', 'Filled', 'Cancelled'), default: 'Open', showInTable: true, showInCard: true, aiContext: true },
        { key: 'requirements', label: 'Requirements', type: 'markdown', showInTable: false, showInCard: true, aiContext: true },
        { key: 'candidates', label: 'Candidates', type: 'relation', target: 'contacts', linkLabel: 'Stage', linkOptions: stageOpts('Proposed', 'Submitted', 'Interview', 'Offer', 'Hired', 'Rejected'), showInTable: true, showInCard: true, aiContext: true },
      );
      p.ui.columns = ['name', 'client', 'status', 'candidates', '_lastContact'];
      db.meta.recordTypes.push(p);
      db.positions = [];
    },
  },
  {
    key: 'sales',
    label: 'Sales',
    description: 'Companies and Deals with a deal-stage dropdown and value.',
    apply(db) {
      const c = db.meta.recordTypes[0];
      c.fieldDefs.push({ key: 'role', label: 'Role', type: 'text', showInTable: false, showInCard: true, aiContext: true });
      const co = makeGenericType('companies', 'Companies', 'Company');
      co.fieldDefs.push(
        { key: 'website', label: 'Website', type: 'url', showInTable: true, showInCard: true, aiContext: true },
        { key: 'industry', label: 'Industry', type: 'select', options: opts('Technology', 'Manufacturing', 'Services', 'Retail', 'Other'), showInTable: true, showInCard: true, aiContext: true },
        { key: 'people', label: 'People', type: 'relation', target: 'contacts', showInTable: true, showInCard: true, aiContext: true },
      );
      co.ui.columns = ['name', 'industry', 'website', 'people', '_lastContact'];
      const d = makeGenericType('deals', 'Deals', 'Deal');
      d.fieldDefs.push(
        { key: 'stage', label: 'Stage', type: 'select', options: stageOpts('Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'), default: 'Lead', showInTable: true, showInCard: true, aiContext: true },
        { key: 'value', label: 'Value', type: 'number', showInTable: true, showInCard: true, aiContext: true },
        { key: 'closeDate', label: 'Expected close', type: 'date', showInTable: true, showInCard: true, aiContext: true },
        { key: 'company', label: 'Company', type: 'relation', target: 'companies', showInTable: true, showInCard: true, aiContext: true },
        { key: 'contactsRel', label: 'Contacts', type: 'relation', target: 'contacts', linkLabel: 'Role', linkOptions: opts('Decision maker', 'Champion', 'Influencer', 'User'), showInTable: false, showInCard: true, aiContext: true },
      );
      d.ui.columns = ['name', 'stage', 'value', 'closeDate', 'company', '_lastContact'];
      db.meta.recordTypes.push(co, d);
      db.companies = []; db.deals = [];
    },
  },
  {
    key: 'personal',
    label: 'Personal network',
    description: 'Relationship dropdown, birthday, how we met.',
    apply(db) {
      const c = db.meta.recordTypes[0];
      c.fieldDefs.push(
        { key: 'relationship', label: 'Relationship', type: 'select', options: opts('Friend', 'Family', 'Colleague', 'Mentor', 'Acquaintance'), showInTable: true, showInCard: true, aiContext: true },
        { key: 'birthday', label: 'Birthday', type: 'date', showInTable: false, showInCard: true, aiContext: true },
        { key: 'howWeMet', label: 'How we met', type: 'longtext', showInTable: false, showInCard: true, aiContext: true },
      );
      c.ui.columns.splice(1, 0, 'relationship');
    },
  },
  {
    key: 'suppliers',
    label: 'Suppliers / Partners',
    description: 'Category dropdown, contract (markdown), renewal date.',
    apply(db) {
      const c = db.meta.recordTypes[0];
      c.fieldDefs.push(
        { key: 'category', label: 'Category', type: 'select', options: opts('Supplier', 'Partner', 'Contractor', 'Service provider'), showInTable: true, showInCard: true, aiContext: true },
        { key: 'contract', label: 'Contract', type: 'markdown', showInTable: false, showInCard: true, aiContext: true },
        { key: 'renewalDate', label: 'Renewal date', type: 'date', showInTable: true, showInCard: true, aiContext: true },
      );
      c.ui.columns.splice(1, 0, 'category');
    },
  },
];

export function starterPrompts() {
  const now = new Date().toISOString();
  const p = (title, category, tags, template, context, system = '') => ({
    id: newId('p'), title, category, tags, system, template, context, favorite: false, uses: 0, createdAt: now, lastUsedAt: null,
  });
  return [
    p('Write a personalised message', 'Messages', ['outreach', 'email'],
      'Write a short, warm, personalised message to {{title}}. Goal: {{goal}}.\nUse the context below to make it specific. Sign as {{me.name}}.\n\n{{me.signature}}\n\nContext:\n{{context}}',
      ['fields:all', 'notes:last5']),
    p('Follow-up after no reply', 'Messages', ['follow-up', 'email'],
      'Write a polite, brief follow-up message to {{title}}, who has not replied to my last message. Reference our last interaction naturally. Max 90 words. Sign as {{me.name}}.\n\nContext:\n{{context}}',
      ['fields:all', 'notes:last3']),
    p('Summarise history with this record', 'Summaries', ['summary'],
      'Summarise my relationship and history with {{title}} in 5 bullet points, then list open questions and a suggested next step.\n\nContext:\n{{context}}',
      ['fields:all', 'docs:all', 'notes:all']),
    p('Extract key facts as tags', 'Data', ['tags', 'extract'],
      'From the context below, extract up to 8 short keyword tags (skills, topics, interests) for {{title}}. Answer ONLY with a comma-separated list.\n\nContext:\n{{context}}',
      ['docs:all', 'notes:all']),
    p('Prepare a meeting brief', 'Summaries', ['meeting', 'brief'],
      'Prepare a one-page meeting brief about {{title}}: who they are, our history, what they care about, 3 smart questions to ask, and risks. Use markdown headings.\n\nContext:\n{{context}}',
      ['fields:all', 'docs:all', 'notes:all']),
    p('Draft a reply to pasted text', 'Messages', ['reply'],
      'Draft a reply to this message from {{title}}:\n"""\n{{input}}\n"""\nTone: friendly and professional. Sign as {{me.name}}.\n\nContext:\n{{context}}',
      ['fields:all', 'notes:last3']),
  ];
}

export function createDatabase(templateKey = 'blank', customSchema = null) {
  const db = emptyDatabase();
  if (customSchema?.recordTypes) {
    db.meta.recordTypes = structuredClone(customSchema.recordTypes);
    if (customSchema.settings) db.meta.settings = { ...db.meta.settings, ...structuredClone(customSchema.settings) };
    if (Array.isArray(customSchema.prompts)) db.meta.prompts = structuredClone(customSchema.prompts);
    for (const t of db.meta.recordTypes) db[t.key] = [];
  } else {
    const t = TEMPLATES.find(x => x.key === templateKey) || TEMPLATES[0];
    t.apply(db);
  }
  if (!db.meta.prompts.length) db.meta.prompts = starterPrompts();
  db.meta.settings.mail = { ...defaultMailSettings(), ...(db.meta.settings.mail || {}) };
  if (!Array.isArray(db.meta.emailTemplates)) db.meta.emailTemplates = starterEmailTemplates();
  db.meta.brand = { ...defaultBrand(), ...(db.meta.brand || {}) };
  db.meta.mailRules = db.meta.mailRules || [];
  return db;
}
