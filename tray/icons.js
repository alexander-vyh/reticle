'use strict';

const { Resvg } = require('@resvg/resvg-js');
const { nativeImage } = require('electron');

// --- SVG template pieces (24x24 viewBox) ---

const SVG_HEADER = `<svg width="24" height="24" viewBox="0 0 24 24"
     xmlns="http://www.w3.org/2000/svg" fill="none">`;

const SVG_DEFS = `
  <defs>
    <mask id="outer-gap-mask" maskUnits="userSpaceOnUse">
      <rect x="0" y="0" width="24" height="24" fill="white"/>
      <rect fill="black" x="19.2" y="11.27" width="3.6" height="1.46"/>
      <rect fill="black" x="11.27" y="1.2" width="1.46" height="3.6"/>
      <rect fill="black" x="1.2" y="11.27" width="3.6" height="1.46"/>
      <rect fill="black" x="11.27" y="19.2" width="1.46" height="3.6"/>
    </mask>
  </defs>`;

const SVG_OUTER_RING = `
  <g mask="url(#outer-gap-mask)">
    <path fill="black" fill-rule="evenodd" d="
      M 22.4 12 A 10.4 10.4 0 1 0 1.6 12 A 10.4 10.4 0 1 0 22.4 12
      M 19.6 12 A 7.6 7.6 0 1 1 4.4 12 A 7.6 7.6 0 1 1 19.6 12"/>
  </g>`;

function svgInnerArcs(rotation) {
  const transform = rotation ? ` transform="rotate(${rotation}, 12, 12)"` : '';
  return `
  <g stroke="black" stroke-width="0.6" stroke-linecap="round" fill="none"${transform}>
    <path d="M 5.4 12 A 6.6 6.6 0 0 1 12 5.4"/>
    <path d="M 18.6 12 A 6.6 6.6 0 0 1 12 18.6"/>
  </g>`;
}

/** Ambient status fill — the "weather" inside the reticle. */
function svgHollow(color) {
  return `
  <circle cx="12" cy="12" r="7.6" fill="${color}"/>`;
}

/** Center star — always black, the fixed north star. */
const SVG_STAR = `
  <path fill="black" d="
    M 12,9.7
    C 12.2,11.1 12.9,11.8 14.3,12
    C 12.9,12.2 12.2,12.9 12,14.3
    C 11.8,12.9 11.1,12.2 9.7,12
    C 11.1,11.8 11.8,11.1 12,9.7 Z"/>`;

const SVG_FOOTER = '</svg>';

/**
 * Build a complete SVG string for the Claudia tray icon.
 * @param {string} statusColor - CSS color for the hollow fill (e.g. '#4CAF50')
 * @param {number} [arcRotation=0] - Degrees to rotate the inner arcs
 * @returns {string} Complete SVG markup
 */
function buildSvg(statusColor, arcRotation = 0) {
  return [
    SVG_HEADER,
    SVG_DEFS,
    SVG_OUTER_RING,
    svgHollow(statusColor),
    svgInnerArcs(arcRotation),
    SVG_STAR,
    SVG_FOOTER,
  ].join('\n');
}

/**
 * Render an SVG string to an Electron nativeImage.
 * Renders at 32x32 pixels with scaleFactor 2 for Retina (displays as 16pt).
 */
function renderIcon(svgString) {
  const resvg = new Resvg(svgString, {
    fitTo: { mode: 'width', value: 32 },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();
  return nativeImage.createFromBuffer(Buffer.from(pngBuffer), {
    width: 32,
    height: 32,
    scaleFactor: 2,
  });
}

module.exports = {
  green:  () => renderIcon(buildSvg('#4CAF50')),
  yellow: () => renderIcon(buildSvg('#FFC107')),
  red:    () => renderIcon(buildSvg('#F44336')),

  /** Generate a single animation frame with rotated arcs. */
  frame: (color, rotation) => renderIcon(buildSvg(color, rotation)),

  /** Exposed for testing / external use. */
  buildSvg,
};
