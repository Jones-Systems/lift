const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export function renderVariant({ demo, articles }) {
  return `<div class="guided-page">
    <section class="guided-intro v-container" aria-labelledby="guided-heading">
      <p class="v-eyebrow">Personal strength &amp; movement · In development</p>
      <h1 id="guided-heading">Start where<br>you are.</h1>
      <p class="guided-deck">Some days, you have a little less time.<br class="guided-wide-break"> Some days, you just need a place to begin.</p>
      <p class="guided-intent">Form is taking shape around your real life. Explore a small example of what that could look like.</p>
      <a class="guided-text-link" href="/variations/guided/how-it-works/">Meet the idea behind Form <span aria-hidden="true">→</span></a>
    </section>

    <section class="guided-picker v-container" aria-labelledby="guided-choice-heading">
      <div class="guided-section-label"><span class="guided-step" aria-hidden="true">01</span><p class="v-eyebrow">A place to begin</p></div>
      <h2 id="guided-choice-heading">What would you like to explore?</h2>
      <p id="guided-choice-help" class="v-muted">Choose an example. You can change it at any time.</p>
      <div class="guided-choices" role="group" aria-labelledby="guided-choice-heading" aria-describedby="guided-choice-help">
        <button class="guided-choice" type="button" data-scenario="short" aria-pressed="true" aria-controls="demo">
          <span class="guided-choice-number" aria-hidden="true">01</span><span class="guided-choice-copy"><strong>A shorter session</strong><span>See how an example changes when time is tight.</span></span><span class="guided-choice-mark" aria-hidden="true"></span>
        </button>
        <button class="guided-choice" type="button" data-scenario="home" aria-pressed="false" aria-controls="demo">
          <span class="guided-choice-number" aria-hidden="true">02</span><span class="guided-choice-copy"><strong>Dumbbells at home</strong><span>Explore a session with a simpler equipment setup.</span></span><span class="guided-choice-mark" aria-hidden="true"></span>
        </button>
        <button class="guided-choice" type="button" data-scenario="explore" aria-pressed="false" aria-controls="demo">
          <span class="guided-choice-number" aria-hidden="true">03</span><span class="guided-choice-copy"><strong>A routine to explore</strong><span>Look around a sample plan, workout, and progress.</span></span><span class="guided-choice-mark" aria-hidden="true"></span>
        </button>
      </div>
      <p class="guided-picker-note">Fictional examples. No personal or health information needed.</p>
      <a class="guided-preview-link" href="#demo">See the selected example <span aria-hidden="true">↓</span></a>
    </section>

    <section class="guided-example" id="demo" aria-labelledby="guided-example-heading">
      <div class="v-container guided-example-inner">
        <div class="guided-section-label"><span class="guided-step" aria-hidden="true">02</span><p class="v-eyebrow">Make it tangible</p></div>
        <h2 id="guided-example-heading" data-guided-title>A little less time. A clear next step.</h2>
        <p class="guided-example-description" data-guided-description>Explore a fictional shorter session, then look at the plan and progress around it.</p>
        <div class="guided-demo-wrap">${demo}</div>
        <details class="guided-disclosure"><summary>What does this example show?</summary><div><p>This is an interactive preview with fictional workout, plan, and progress information. It illustrates the experience Form is developing.</p><p>Changing a choice changes the example, not a personal assessment. This page does not create an account or save a training plan.</p></div></details>
      </div>
    </section>

    <section class="guided-approach v-container" aria-labelledby="guided-approach-heading">
      <div class="guided-section-label"><span class="guided-step" aria-hidden="true">03</span><p class="v-eyebrow">The idea behind the experience</p></div>
      <h2 id="guided-approach-heading">More context.<br>A more useful next step.</h2>
      <p class="guided-section-deck">Form’s intended approach connects the plan, the session, and what you learn along the way.</p>
      <ol class="guided-process">
        <li><span class="guided-process-count" aria-hidden="true">1</span><div><h3>Begin with your day</h3><p>Your goals, available time, and equipment give the conversation a starting point.</p></div></li>
        <li><span class="guided-process-count" aria-hidden="true">2</span><div><h3>Understand the adjustment</h3><p>See what changes and why, with room to review and correct the context.</p></div></li>
        <li><span class="guided-process-count" aria-hidden="true">3</span><div><h3>Keep the thread</h3><p>Connect guided sessions and logging with progress you can look back on.</p></div></li>
      </ol>
      <div class="guided-onward"><a class="v-button" href="/variations/guided/how-it-works/">How Form is taking shape <span aria-hidden="true">→</span></a><a class="guided-text-link" href="/variations/guided/use-cases/">Explore other starting points</a></div>
    </section>

    <section class="guided-reading v-container" aria-labelledby="guided-reading-heading">
      <div class="guided-reading-heading"><div><p class="v-eyebrow">A little more perspective</p><h2 id="guided-reading-heading">Worth a read.</h2></div><a class="guided-text-link" href="/variations/guided/journal/">The Form journal <span aria-hidden="true">→</span></a></div>
      <div class="guided-articles">${articles.map(article => `<a class="guided-article" href="${escape(article.href)}"><h3>${escape(article.title)}</h3><p>${escape(article.description)}</p><span class="guided-article-arrow" aria-hidden="true">→</span></a>`).join('')}</div>
    </section>
  </div>`;
}
