// Email templates and the brand kit stored in the database (meta.emailTemplates, meta.brand).
import { newId } from './schema.js';
import { starterDesigns } from './email-design.js';

export function defaultBrand() {
  return {
    logo: '', // data: URL (embedded in mails as an inline image)
    logoWidth: 140,
    companyName: '',
    primary: '#2f6fed',
    accent: '#ff8a3d',
    background: '#f3f5f8',
    surface: '#ffffff',
    text: '#1f2933',
    muted: '#6b7785',
    font: 'system', // system | arial | georgia | verdana | trebuchet | google:<Family>
    buttonShape: 'rounded', // rounded | pill | square
    buttonStyle: 'filled', // filled | outline
    footer: '',
    address: '',
    social: [], // [{ kind: 'linkedin'|'x'|'instagram'|'facebook'|'youtube'|'web', url }]
  };
}

export function defaultMailSettings() {
  return {
    scope: 'contacts', // contacts | all
    days: 365,
    lastContactIncludesEmail: true,
    images: 'ask', // ask | always
    allowImagesFrom: [],
    intentDetection: true,
    includeInSearch: false,
    bulkSpacingSec: 20,
  };
}

/** Plain (text / markdown) starter templates. Designed HTML templates are added by email-design.js. */
export function starterEmailTemplates() {
  const now = new Date().toISOString();
  const t = (name, category, tags, subject, body) => ({ id: newId('et'), name, category, tags, subject, body, design: null, html: null, tracking: 'default', uses: 0, createdAt: now });
  return [
    t('Introduction', 'Outreach', ['intro'], 'Nice to meet you, {{fullName|first|or:"there"}}',
      'Hi {{fullName|first|or:"there"}},\n\nI came across your profile and wanted to introduce myself. I think there could be a good fit with what you do{{?Reason|or:""}}.\n\nWould you be open to a short call next week?\n\nBest regards,\n{{me.name}}'),
    t('Follow-up', 'Outreach', ['follow-up'], 'Following up',
      'Hi {{fullName|first|or:"there"}},\n\nJust following up on my previous message in case it got buried. Happy to share more details whenever suits you.\n\nBest,\n{{me.name}}'),
    t('Thank you', 'General', ['thanks'], 'Thank you, {{fullName|first|or:"there"}}!',
      'Hi {{fullName|first|or:"there"}},\n\nThank you for your time today. It was great talking with you.\n\nAs promised, the next step is: {{?Next step}}.\n\nKind regards,\n{{me.name}}'),
    t('Meeting request', 'Meetings', ['meeting'], 'Quick call?',
      'Hi {{fullName|first|or:"there"}},\n\nWould you have 20 minutes for a quick call? You can pick any time that suits you here: {{?Booking link}}\n\nThanks,\n{{me.name}}'),
    ...starterDesigns().map(d => ({ id: newId('et'), tracking: 'default', uses: 0, createdAt: now, html: null, ...d })),
  ];
}
