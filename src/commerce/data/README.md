# Dataset attribution and provenance

`retail.json` is an adapted extract of **Online Retail** by Daqing Chen (2015), UCI Machine Learning Repository, DOI [10.24432/C5BW33](https://doi.org/10.24432/C5BW33).

**Data license: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)**. This data is not relicensed under the application's MIT license.

[Original dataset](https://archive.ics.uci.edu/dataset/352/online%2Bretail) · [Original download](https://archive.ics.uci.edu/static/public/352/online%2Bretail.zip).

Modifications: XLSX cells decoded into JSON, source spreadsheet rows retained, unit prices represented in integer millionths of a pound, and the first 500 complete invoice groups selected. No customer names or invented fulfillment information are added. Rust performs aggregation and adds demo review rules; review state is kept separately from these source facts.

`source.json` records selection, date range, row counts, citation, license, and SHA-256 checksums. Regenerate with `python3 scripts/import-commerce.py --download`. See [the demo guide](../../../docs/COMMERCE-DEMO.md).
