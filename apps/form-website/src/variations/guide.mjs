import { escapeHtml, safeHref } from '../shell.mjs';

export function renderVariant({ demo, articles }) {
  const stories = articles.map(article => ({
    href: escapeHtml(safeHref(article.href)),
    title: escapeHtml(article.title),
    description: escapeHtml(article.description)
  }));
  const lead = stories[0];
  return `<div class="guide-page">
    <header class="guide-masthead v-container">
      <div class="guide-edition"><span>Form / The Field Guide</span><span>Strength. Movement. Everyday life.</span></div>
      <h1>A little more<br><span>understanding.</span></h1>
      <div class="guide-introduction"><p>Make room for movement.<br>Start with a clearer picture.</p><p>A field guide to the thinking behind Form: a strength and movement app in development, built around the life you actually lead.</p></div>
      <nav class="guide-contents" aria-label="Field Guide contents"><span class="v-eyebrow">In this guide</span><a href="#guide-reading">01 / Read the journal</a><a href="#demo">02 / Inside Form</a><a href="#guide-practice">03 / Put it in context</a></nav>
    </header>
    <section class="guide-opening v-container" aria-label="Featured reading and Form preview">
      <article class="guide-feature">
        <div class="guide-kicker"><span class="v-eyebrow">The opening note</span><span aria-hidden="true">→</span></div>
        <div class="guide-feature-copy"><p class="guide-feature-label">A place to begin</p><h2>${lead ? lead.title : 'A plan begins with context.'}</h2><p>${lead ? lead.description : 'Explore the ideas behind a more personal approach to strength and movement.'}</p></div>
        <a class="guide-read-link" href="${lead ? lead.href : '/variations/guide/journal/'}"><span>Read the opening note</span><span aria-hidden="true">→</span></a>
        <div class="guide-margin-note"><span class="guide-note-mark" aria-hidden="true">F.</span><p>Good questions before<br>the next repetition.</p></div>
      </article>
      <aside class="guide-inside" aria-labelledby="guide-inside-title"><div class="guide-inside-heading"><p class="v-eyebrow">Inside Form</p><h2 id="guide-inside-title">From an idea<br>to your next step.</h2><p class="v-muted">Explore a sample workout, plan and progress view.</p></div><div id="demo" class="guide-demo">${demo}</div><p class="guide-demo-note">A hands-on illustration with synthetic data. Your own context would come first.</p></aside>
    </section>
    <section id="guide-reading" class="guide-reading v-container" aria-labelledby="guide-reading-title">
      <div class="guide-section-heading"><div><p class="v-eyebrow">01 / The reading room</p><h2 id="guide-reading-title">Ideas to take with you.</h2></div><a href="/variations/guide/journal/">Visit the journal <span aria-hidden="true">→</span></a></div>
      <ol class="guide-story-list">${stories.map((story, index) => `<li><a href="${story.href}"><span class="guide-story-number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><h3>${story.title}</h3><p>${story.description}</p><span class="guide-story-arrow" aria-hidden="true">→</span></a></li>`).join('')}</ol>
    </section>
    <section id="guide-practice" class="guide-practice v-container" aria-labelledby="guide-practice-title">
      <div class="guide-practice-intro"><p class="v-eyebrow">03 / In everyday practice</p><h2 id="guide-practice-title">The plan meets<br>the person.</h2><p>Some days you have a full hour. Some days, a small window. Form is being designed to keep your context part of the conversation.</p><a class="v-button secondary" href="/variations/guide/use-cases/">Explore the use cases <span aria-hidden="true">→</span></a></div>
      <ol class="guide-walkthrough"><li><span class="guide-step-number">01</span><div><h3>Begin with what is true today.</h3><p>Your available time, equipment and goals are useful starting points. A workable plan needs room for each.</p></div></li><li><span class="guide-step-number">02</span><div><h3>Make the choices understandable.</h3><p>The intended experience explains the reasoning behind a session and lets you correct the context it uses.</p></div></li><li><span class="guide-step-number">03</span><div><h3>Leave a note for next time.</h3><p>Recording what you did and how it felt can give your next session a more useful starting point.</p></div></li></ol>
    </section>
    <section class="guide-closing v-container" aria-labelledby="guide-closing-title"><p class="v-eyebrow">Keep exploring</p><h2 id="guide-closing-title">A thoughtful beginning.<br>A practical next step.</h2><div class="guide-closing-links"><a class="v-button" href="#demo">Try the interactive preview <span aria-hidden="true">→</span></a><a class="guide-text-link" href="/variations/guide/how-it-works/">How Form is intended to work <span aria-hidden="true">→</span></a></div><p class="v-muted">Form is in development. This guide introduces the concept and its intended experience.</p></section>
  </div>`;
}
