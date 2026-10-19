const mounted = new WeakMap();
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export function matchesJournal({ text, collection }, { query = '', collection: selected = '' } = {}) {
  return (!selected || collection === selected) && normalize(query).split(' ').filter(Boolean).every(term => normalize(text).includes(term));
}

export function mountJournal(element) {
  if (mounted.has(element)) return mounted.get(element);
  const form = element.querySelector('[data-journal-form]');
  const search = element.querySelector('[data-journal-search]');
  const collection = element.querySelector('[data-journal-collection]');
  const status = element.querySelector('[data-journal-status]');
  const empty = element.querySelector('[data-journal-empty]');
  if (!form || !search || !collection || !status || !empty) throw new TypeError('Incomplete journal view');
  const cards = [...element.querySelectorAll('[data-journal-card]')].map(node => ({ node, text: node.textContent, collection: node.dataset.collection }));
  function apply() {
    let visible = 0;
    for (const card of cards) {
      card.node.hidden = !matchesJournal(card, { query: search.value, collection: collection.value });
      if (!card.node.hidden) visible += 1;
    }
    empty.hidden = visible !== 0;
    const next = `${visible} of ${cards.length} ${cards.length === 1 ? 'article' : 'articles'} shown.`;
    if (status.textContent !== next) status.textContent = next;
  }
  function submit(event) { event.preventDefault(); apply(); }
  function reset(event) {
    event.preventDefault();
    search.value = '';
    collection.value = '';
    apply();
    search.focus();
  }
  form.addEventListener('submit', submit);
  form.addEventListener('reset', reset);
  form.hidden = false;
  apply();
  const cleanup = () => {
    form.removeEventListener('submit', submit);
    form.removeEventListener('reset', reset);
    form.hidden = true;
    for (const card of cards) card.node.hidden = false;
    empty.hidden = cards.length !== 0;
    status.textContent = `${cards.length} ${cards.length === 1 ? 'article' : 'articles'} available.`;
    mounted.delete(element);
  };
  mounted.set(element, cleanup);
  return cleanup;
}

if (typeof document !== 'undefined') {
  for (const element of document.querySelectorAll('[data-me-journal]')) mountJournal(element);
}
