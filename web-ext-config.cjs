// Shared web-ext config, used by both local builds and CI signing.
// Keeps dev-only content out of the shipped package.
module.exports = {
  ignoreFiles: [
    'tracks',
    'tracks/**',
    'test',
    'test/**',
    'icons/icon-128.png',
    'web-ext-config.cjs',
  ],
};
