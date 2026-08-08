// Builds a real .rdb (CFB container) in memory, in the QuickSet layout the
// parser expects. Used by the parser/extractor tests and by the demo-fixture
// script — no genuine relay database is needed to exercise the pipeline.
//
// profiles: [{ name, relayType, sections: [{ key, desc, settings }] }]

import CFB from 'cfb';

function settingsFileText(relayType, section) {
  const lines = ['[INFO]', `RELAYTYPE=${relayType}`, 'FID=TEST-FID', '', `[${section.key}]`];
  for (const [key, value] of Object.entries(section.settings)) {
    lines.push(`${key},"${value}"`);
  }
  return lines.join('\r\n');
}

function makeRdb(profiles) {
  const container = CFB.utils.cfb_new();

  for (const profile of profiles) {
    const cfgLines = [
      '[CLASSES]',
      ...profile.sections.map((section, i) => `"${section.key}","${section.desc ?? section.key}","Set_${i + 1}.txt"`),
    ];
    CFB.utils.cfb_add(
      container,
      `/Relays/${profile.name}/Cfg.txt`,
      Buffer.from(cfgLines.join('\r\n')),
    );
    profile.sections.forEach((section, i) => {
      CFB.utils.cfb_add(
        container,
        `/Relays/${profile.name}/Set_${i + 1}.txt`,
        Buffer.from(settingsFileText(profile.relayType ?? 'SEL-451', section)),
      );
    });
  }

  return Buffer.from(CFB.write(container, { type: 'buffer' }));
}

export { makeRdb };
