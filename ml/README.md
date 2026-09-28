# ml/ — NigeriaPass ML stack

Real end-to-end ML: synthetic Nigerian data lakehouse (parquet), PyTorch
models (fraud MLP, credit MLP, pure-torch GraphSAGE), training loops with
early stopping and class-imbalance handling, file/MLflow registry,
champion/challenger A/B router, FastAPI CPU serving (ONNX Runtime or torch),
PSI/KS drift monitoring, and a continuous-training job that reads Postgres
when `POSTGRES_URL`/`DATABASE_URL` is set (synthetic fallback otherwise).

Full architecture, limitations, and runbooks: **../docs/ML.md**.

Quick start:

```
pip install pandas pyarrow scikit-learn onnx onnxruntime fastapi uvicorn
python ml/synthetic/generate.py                       # bronze layer
python ml/synthetic/features.py                       # silver + gold
python ml/training/train_fraud.py --version v1
python ml/training/train_credit.py --version v1
python ml/training/train_gnn.py --version v1
python ml/tests/smoke_test.py                         # loads artifacts, scores
ML_SCORING_PORT=8090 python -m uvicorn ml.serving.score_server:app
```

Node bridge: `server/ml/scoring.ts` (env `ML_SCORING_URL`; deterministic
heuristic fallback when the server is absent — never random scores).

Trained weights live in `ml/artifacts/<model>/<version>/` and are committed
(each < 10MB). Registry state in `ml/registry/store/`.
