export const VIDEO_READY_TEXT = 'Your video is ready!';

/** Drop generated videos. Images and audio stay. Text is unchanged when there is no video. */
export function withoutVideos(result) {
  const media = result?.media || [];
  if (!media.some((m) => m && m.type === 'video')) return result;
  return { ...result, text: VIDEO_READY_TEXT, media: [] };
}

/**
 * Render a Gemini reply into a bubble.
 * A generated video is replaced by the ready message: no player, no download link,
 * and no other media from that same reply.
 */
export function appendReplyContent(bubble, text, media, doc) {
  const shown = withoutVideos({ text, media });
  for (const m of shown.media || []) {
    if (m.type === 'image') {
      const img = doc.createElement('img');
      img.className = 'thumb';
      img.src = m.url;
      img.alt = m.title || 'Generated image';
      bubble.appendChild(img);
    } else if (m.type === 'audio') {
      const a = doc.createElement('audio');
      a.controls = true;
      a.src = m.url;
      a.style.width = '100%';
      bubble.appendChild(a);
    } else if (m.type === 'video') {
      continue;
    } else if (m.url) {
      const link = doc.createElement('a');
      link.href = m.url;
      link.textContent = m.title || m.filename || 'Download';
      link.target = '_blank';
      bubble.appendChild(link);
    }
  }
  if (shown.text) {
    const span = doc.createElement('div');
    span.textContent = shown.text;
    bubble.appendChild(span);
  }
}
