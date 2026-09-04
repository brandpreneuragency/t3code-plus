# Review the model catalogue

The Models page lists the models in your connected catalogue alongside the models exposed by the
providers in the current T3 Code environment. Available models show one badge for each provider
instance that offers them; catalogue-only models remain visible for comparison.

Open **Settings → Integrations → Model catalogue** to connect the page. Enter the catalogue URL,
username, and password. T3 Code stores the credential on the server and does not send it back to
clients. Use an HTTPS URL; plaintext HTTP is rejected before credentials are attached. Clearing the
URL disables the connection and hides Models from the sidebar.

Use search to filter by model name, catalogue ID, or vendor, or turn on **Available only** to hide
catalogue-only entries. Expand a model to review its best-use and avoid-for notes. The catalogue is
read-only in T3 Code; make changes in the catalogue's source application.

If the catalogue becomes unreachable after a successful load, T3 Code keeps showing the last good
snapshot and labels it with **as of** and the snapshot time. If no snapshot is available yet, retry
after the connection is restored. An invalid response is shown as an error instead of an empty
catalogue.
