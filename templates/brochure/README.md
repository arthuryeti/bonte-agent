# Brochure brand assets

These assets match https://bontefilipidis.com/ (retrieved 2026-09-08):

- `logo.png` and `logo-white.png`: rasterized at 1000 px from `/wp-content/uploads/2022/10/logo-original.svg`.
- `Berlingske-Serif.ttf`: headings, from `/wp-content/uploads/fonts/Berlingske-Serif.woff2`.
- `GothamSSm-Book.ttf`: body text, from `/wp-content/uploads/fonts/GothamSSm-Book.woff2`.
- `Julietta.ttf`: cover signature, from `/wp-content/uploads/fonts/Julietta.woff2`.

Fonts were decoded to TrueType with fontTools for reliable PDFKit subsetting.
Assets are bundled so rendering requires no website requests. The Docker image
already includes `templates/`. Custom brand names, logos, and colors still use
`PROPERTY_PDF_*` settings.
