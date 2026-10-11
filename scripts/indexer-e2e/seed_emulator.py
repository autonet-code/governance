# Indexer end-to-end: write contracts/Localhost config docs into the Firestore EMULATOR only.
#   python scripts/indexer-e2e/seed_emulator.py <indexer dir>
import json, os, sys
os.environ["FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:8080"  # never touch production
import firebase_admin
from firebase_admin import credentials, firestore

indexer_dir = sys.argv[1]
dep = json.load(open(os.path.join(os.path.dirname(__file__), "out", "deployment.json")))
for name, cred in [("homebase", "homebase.json"), ("trustless", "secrets/trustless.json")]:
    app = firebase_admin.initialize_app(credentials.Certificate(os.path.join(indexer_dir, cred)), name=name)
    db = firestore.client(app)
    db.collection("contracts").document("Localhost").set(dep)
    print(name, app.project_id, "seeded contracts/Localhost")
