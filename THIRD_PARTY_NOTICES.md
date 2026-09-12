# Third-party notices

## CityU Beamer theme code

`templates/beamer/beamerthemeBrand.sty` is a substantive neutral adaptation of
the original `beamerthemeCityU.sty` from the upstream CityU Beamer project.
The upstream theme code is available in `upstream/cityu-beamer/` in this
repository and is distributed under the MIT License. The retained copyright
notice and MIT terms are included in `templates/beamer/LICENSE` and in every
BrandBeamer export.

This adaptation changes the visual system: its page backgrounds are newly
drawn with TikZ, its palette is configured through `BrandPrimary`, and an
optional user-supplied PNG or JPEG logo is kept as a separate file. It does not
copy or redistribute the upstream CityU PNG artwork, logos, previews, source
presentation, or other branded assets. The upstream `NOTICE.md` explains that
those assets have a separate licensing scope and are not covered by its MIT
License.

## TeX packages

The exported source uses packages supplied by the user's TeX installation:

- Beamer and PGF/TikZ are distributed under their own package licenses.
- `ctex` and the Fandol fonts are distributed under their own package and font
  licenses.
- `xcolor`, `etoolbox`, and `graphicx` are distributed under their own package
  licenses.

BrandBeamer does not vendor these packages. Review the licenses installed with
the selected TeX distribution before redistributing compiled documents.
