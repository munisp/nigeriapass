"""Tabular fraud classifier MLP.

Input: raw FRAUD_FEATURES vector (14 dims). A frozen standardization layer
(mean/std buffers fitted on the training split) is baked INTO the model so the
exported ONNX graph accepts raw features — no preprocessing drift between
training and serving. Output: calibrated fraud probability (sigmoid).
"""
from __future__ import annotations

import torch
import torch.nn as nn

FEATURE_DIM = 14  # len(FRAUD_FEATURES)


class FraudMLP(nn.Module):
    def __init__(self, in_features: int = FEATURE_DIM, hidden: int = 64,
                 dropout: float = 0.1):
        super().__init__()
        self.register_buffer("feat_mean", torch.zeros(in_features))
        self.register_buffer("feat_std", torch.ones(in_features))
        self.net = nn.Sequential(
            nn.Linear(in_features, hidden), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(hidden, hidden), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(hidden, hidden), nn.ReLU(),
            nn.Linear(hidden, 1),
        )

    def set_scaler(self, mean, std):
        self.feat_mean.copy_(torch.as_tensor(mean, dtype=torch.float32))
        self.feat_std.copy_(torch.as_tensor(std, dtype=torch.float32).clamp(min=1e-6))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: [B, in_features] raw features -> [B] calibrated probability."""
        z = (x - self.feat_mean) / self.feat_std
        logits = self.net(z).squeeze(-1)
        return torch.sigmoid(logits)

    def logits(self, x: torch.Tensor) -> torch.Tensor:
        z = (x - self.feat_mean) / self.feat_std
        return self.net(z).squeeze(-1)
