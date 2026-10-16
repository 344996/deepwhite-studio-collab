# Tailwind CSS build-time extractor

Source: [Tailwind Labs v3.4.17](https://github.com/tailwindlabs/tailwindcss/tree/v3.4.17), MIT license in [LICENSE](LICENSE).

These files are used only by the offline canvas CSS builder. Original logic is retained; the files use `.mjs` and the two imports in `defaultExtractor.mjs` point to their adjacent `.mjs` files. The existing application compiler at `static/vendor/js/tailwindcss-cdn.js` remains unchanged and supplies the pinned 3.4.17 compiler during the build.

Original paths and SHA-256:

| File | Original path | Original SHA-256 |
|---|---|---|
| defaultExtractor.mjs | src/lib/defaultExtractor.js | f8ccd5f96dbb125fad16b3046be43df6f2f2343960c17e40e4d073d4507798ea |
| regex.mjs | src/lib/regex.js | 1cb3ba29aec019a88f6ea89b7ad891628f3ab47e8ce5f349c67adf39b6ef2423 |
| splitAtTopLevelOnly.mjs | src/util/splitAtTopLevelOnly.js | b139f4f1a10c438d87d6e8c576becebda3cadf23100dbb73fd836b22a69edba9 |
