/**
 * The strip under the app that says what this page is. It sits in the page's
 * flow below the app rather than over it, so it covers nothing, and it comes
 * last in the tab order.
 */
const REPOSITORY = 'https://github.com/JohanLindvall/Cascade';

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

const notice = document.createElement('aside');
notice.className = 'demo-notice';
notice.setAttribute('aria-label', 'About this demo');

const dot = span('demo-notice-dot', '');
dot.setAttribute('aria-hidden', 'true');

const message = span('demo-notice-text', '');
const title = document.createElement('strong');
title.textContent = 'Live demo';
message.append(
  title,
  span('demo-notice-long', ' — a simulated rtorrent running in your browser; nothing is downloaded.'),
  span('demo-notice-short', ' · simulated, nothing downloads'),
);

const link = document.createElement('a');
link.className = 'demo-notice-link';
link.href = REPOSITORY;
link.target = '_blank';
link.rel = 'noopener noreferrer';
link.append(span('demo-notice-long', 'Cascade on GitHub'), span('demo-notice-short', 'GitHub'), span('visually-hidden', ' (opens in a new tab)'));

notice.append(dot, message, link);
document.body.append(notice);
