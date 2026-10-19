const briefs = Object.freeze({
  strength: {
    title: 'Make space for strength.',
    copy: 'A future planning conversation could explore your experience, equipment and preferences before suggesting a routine.',
    caution: 'No workout has been generated. Personalized planning is in development.'
  },
  routine: {
    title: 'Give your routine a place to begin.',
    copy: 'A future planning conversation could ask what you enjoy, what gets in the way and which days feel realistic.',
    caution: 'This is a planning illustration. It does not predict weight change or other outcomes.'
  },
  return: {
    title: 'Keep your current context in view.',
    copy: 'A future planning conversation could help you record clinician-set restrictions and questions about returning to movement.',
    caution: 'After injury or illness, clinician clearance comes first. This preview cannot assess readiness or prescribe rehabilitation.'
  }
});

for (const preview of document.querySelectorAll('[data-plan-preview]')) {
  const form = preview.querySelector('form');
  if (!form) continue;
  const update = () => {
    const selected = form.querySelector('input[name="goal"]:checked')?.value;
    const brief = briefs[selected] ?? briefs.strength;
    const rawMinutes = Number(form.querySelector('input[name="minutes"]')?.value);
    const minutes = Number.isFinite(rawMinutes) ? Math.min(45, Math.max(10, Math.round(rawMinutes / 5) * 5)) : 20;
    const values = {
      '[data-time-output]': `${minutes} minutes`,
      '[data-plan-title]': brief.title,
      '[data-plan-copy]': brief.copy,
      '[data-plan-time]': `A ${minutes}-minute window`,
      '[data-plan-caution]': brief.caution
    };
    for (const [selector, value] of Object.entries(values)) {
      const element = preview.querySelector(selector);
      if (element) element.textContent = value;
    }
  };
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
}

for (const section of document.querySelectorAll('[data-conversion-preview]')) {
 const update=()=>{
  const goal=section.querySelector('input[name="conversion"]:checked')?.value;
  section.querySelector('[data-conversion-status]').textContent=`${goal==='download'?'App download':'Website membership'} is unavailable. No verified provider route is configured.`;
 };
 section.addEventListener('change',update);update();
}
