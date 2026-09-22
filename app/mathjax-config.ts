import mathjax from "mathjax/package.json";
import font from "@mathjax/mathjax-newcm-font/package.json";

// Both browser entry points use the same pinned, local MathJax assets.
export const mathJaxScriptUrl = `/vendor/mathjax-${mathjax.version}/tex-svg.js`;
export const mathJaxConfig = `window.MathJax = {
  loader: { paths: { mathjax: '/vendor/mathjax-${mathjax.version}', fonts: '/vendor' } },
  output: { linebreaks: { inline: false }, fontPath: '/vendor/%%FONT%%-font-${font.version}' },
  tex: { packages: { '[-]': ['noundefined'] } },
  svg: { fontCache: 'local' },
  options: { enableMenu: false }
};`;
