# Indexer end-to-end: write the Localhost network file the indexer starts from, from out/deployment.json,
# into E2E_NETWORKS/networks/Localhost.json (the indexer reads it through NETWORKS_SOURCE=dir:E2E_NETWORKS).
#   python scripts/indexer-e2e/seed_network.py
import json, os

here = os.path.dirname(__file__)
dep = json.load(open(os.path.join(here, "out", "deployment.json")))
dep["name"] = "Localhost"
d = os.path.join(os.environ["E2E_NETWORKS"], "networks")
os.makedirs(d, exist_ok=True)
with open(os.path.join(d, "Localhost.json"), "w") as f:
    json.dump(dep, f, indent=2)
print("wrote", os.path.join(d, "Localhost.json"))
