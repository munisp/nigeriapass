"""Fleet credit-limit scorer MLP.

Classifies probability of default; credit limit = (1 - p_default) * tier cap.
Scorecard-style monotone (log1p) transforms are applied upstream in the
feature builder (see ml/synthetic/features.py CREDIT_FEATURES) so every input
is monotone in the underlying raw behaviour, scorecard-fashion. A frozen
standardization layer is baked into the model as with FraudMLP.
"""
from __future__ import annotations

import torch
import torch.nn as nn

FEATURE_DIM = 10  # len(CREDIT_FEATURES)

# Tier caps in naira used to convert PD -> suggested credit limit.
TIER_CAPS_NAIRA = {1: 5_000.0, 2: 50_000.0, 3: 250_000.0}


class CreditMLP(nn.Module):
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
        """x: [B, in_features] -> [B] probability of default."""
        z = (x - self.feat_mean) / self.feat_std
        return torch.sigmoid(self.net(z).squeeze(-1))

    def logits(self, x: torch.Tensor) -> torch.Tensor:
        z = (x - self.feat_mean) / self.feat_std
        return self.net(z).squeeze(-1)


def pd_to_credit_limit(p_default: float, kyc_tier: int) -> float:
    """Scorecard conversion: limit = cap * (1 - PD)."""
    cap = TIER_CAPS_NAIRA.get(int(kyc_tier), TIER_CAPS_NAIRA[1])
    return round(cap * max(0.0, 1.0 - p_default), 2)
