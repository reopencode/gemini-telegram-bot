/**
 * The Mini App must not render a generated video, player, or download link.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));

function element(doc, tag) {
  return {
    tag,
    attrs: {},
    children: [],
    text: '',
    className: '',
    controls: false,
    style: {},
    set textContent(value) {
      this.text = String(value);
    },
    get textContent() {
      return [this.text, ...this.children.map((c) => c.textContent || '')].filter(Boolean).join('');
    },
    set src(value) {
      this.attrs.src = value;
    },
    get src() {
      return this.attrs.src;
    },
    set href(value) {
      this.attrs.href = value;
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}

function fakeDocument() {
  return {
    createElement(tag) {
      return element(null, tag);
    },
  };
}

describe('mini app video withholding', () => {
  test('a video payload becomes the ready message with no player or link', async () => {
    const { appendReplyContent } = await import('../public/videoReply.js');
    const doc = fakeDocument();
    const bubble = doc.createElement('div');
    appendReplyContent(bubble, 'Here is the ocean clip I rendered for you.', [
      { type: 'video', url: '/media/clip.mp4', filename: 'clip.mp4', title: 'clip' },
      { type: 'image', url: '/media/still.png', title: 'still' },
    ], doc);
    assert.equal(bubble.textContent, 'Your video is ready!');
    assert.equal(bubble.children.some((n) => n.tag === 'video'), false);
    assert.equal(bubble.children.some((n) => n.tag === 'a'), false);
    assert.equal(bubble.children.some((n) => n.tag === 'img'), false);
    assert.equal(JSON.stringify(bubble).includes('/media/clip.mp4'), false);
  });

  test('images and audio still render', async () => {
    const { appendReplyContent } = await import('../public/videoReply.js');
    const doc = fakeDocument();
    const imageBubble = doc.createElement('div');
    appendReplyContent(imageBubble, 'A painting.', [
      { type: 'image', url: '/media/art.png', title: 'art' },
    ], doc);
    assert.equal(imageBubble.children.some((n) => n.tag === 'img' && n.src === '/media/art.png'), true);
    assert.equal(imageBubble.textContent.includes('A painting.'), true);

    const audioBubble = doc.createElement('div');
    appendReplyContent(audioBubble, 'A short tune.', [
      { type: 'audio', url: '/media/tune.mp3', title: 'Tune' },
    ], doc);
    assert.equal(audioBubble.children.some((n) => n.tag === 'audio' && n.src === '/media/tune.mp3'), true);
    assert.equal(audioBubble.textContent.includes('A short tune.'), true);
    assert.equal(audioBubble.children.some((n) => n.tag === 'video'), false);
  });

  test('app.js does not build a video player', () => {
    const src = fs.readFileSync(appPath, 'utf8');
    assert.equal(src.includes("createElement('video')") || src.includes('createElement("video")'), false);
    assert.match(src, /appendReplyContent/);
  });
});
