"""2-layer GraphSAGE in PURE PyTorch (no torch_geometric).

Mean aggregator, mini-batch neighbor sampling. Graph nodes = users / devices /
IPs / cards; edges = shared-attribute (uses_device, uses_ip) and transfers.

Components:
  - SAGEConv: h_v = W_self x_v + W_neigh mean_{u in N(v)} x_u
  - NeighborSampler: CSR adjacency, fanout sampling, builds per-layer blocks
  - GraphSAGE.forward_blocks: mini-batch inference over sampled blocks
  - GraphSAGE.full_forward: dense full-graph forward (used for ONNX export
    and batch scoring in the score server)
"""
from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


class SAGEConv(nn.Module):
    def __init__(self, in_dim: int, out_dim: int):
        super().__init__()
        self.w_self = nn.Linear(in_dim, out_dim, bias=False)
        self.w_neigh = nn.Linear(in_dim, out_dim, bias=True)

    def forward(self, h_self: torch.Tensor, h_neigh_mean: torch.Tensor):
        return self.w_self(h_self) + self.w_neigh(h_neigh_mean)


class GraphSAGE(nn.Module):
    def __init__(self, in_dim: int, hidden: int = 32, num_layers: int = 2,
                 dropout: float = 0.2):
        super().__init__()
        assert num_layers >= 1
        dims = [in_dim, hidden] + [hidden] * (num_layers - 1)
        self.convs = nn.ModuleList(
            [SAGEConv(dims[i], dims[i + 1]) for i in range(num_layers)])
        self.head = nn.Linear(hidden, 1)
        self.dropout = dropout
        self.num_layers = num_layers

    # ---- mini-batch path --------------------------------------------------
    def forward_blocks(self, x: torch.Tensor, blocks: list[dict]) -> torch.Tensor:
        """x: features of the union of nodes needed by this batch.
        blocks[i] has keys src_local, dst_local (LongTensors) for layer i.
        Returns logits for the seed nodes (block[-1] dst nodes)."""
        h = x
        for i, (conv, blk) in enumerate(zip(self.convs, blocks)):
            src, dst, n_dst = blk["src_local"], blk["dst_local"], blk["n_dst"]
            agg = torch.zeros(n_dst, h.shape[1], device=h.device)
            agg.index_add_(0, dst, h[src])
            deg = torch.zeros(n_dst, device=h.device)
            deg.index_add_(0, dst, torch.ones(len(src), device=h.device))
            agg = agg / deg.clamp(min=1).unsqueeze(1)
            # dst nodes occupy the first n_dst rows of the block's node set
            h = conv(h[:n_dst], agg)
            if i < self.num_layers - 1:
                h = F.relu(h)
                h = F.dropout(h, self.dropout, self.training)
        return self.head(h).squeeze(-1)

    # ---- full-graph path (export / batch inference) -----------------------
    def full_forward(self, x: torch.Tensor, edge_src: torch.Tensor,
                     edge_dst: torch.Tensor) -> torch.Tensor:
        """Mean-aggregate over the full graph each layer. Returns logits [N]."""
        h = x
        n = x.shape[0]
        for i, conv in enumerate(self.convs):
            agg = torch.zeros(n, h.shape[1], device=h.device, dtype=h.dtype)
            agg.index_add_(0, edge_dst, h[edge_src])
            deg = torch.zeros(n, device=h.device, dtype=h.dtype)
            deg.index_add_(0, edge_dst, torch.ones_like(edge_dst, dtype=h.dtype))
            agg = agg / deg.clamp(min=1).unsqueeze(1)
            h = conv(h, agg)
            if i < self.num_layers - 1:
                h = F.relu(h)
        return self.head(h).squeeze(-1)


class NeighborSampler:
    """CSR adjacency + uniform fanout neighbor sampling (with replacement)."""

    def __init__(self, edge_src: np.ndarray, edge_dst: np.ndarray, n_nodes: int,
                 seed: int = 0):
        edge_src = np.asarray(edge_src, dtype=np.int64)
        edge_dst = np.asarray(edge_dst, dtype=np.int64)
        order = np.argsort(edge_dst, kind="stable")
        self.src = np.ascontiguousarray(edge_src[order])
        dst_sorted = np.ascontiguousarray(edge_dst[order])
        self.indptr = np.zeros(n_nodes + 1, dtype=np.int64)
        np.add.at(self.indptr, dst_sorted + 1, 1)
        self.indptr = np.cumsum(self.indptr)
        self.rng = np.random.default_rng(seed)

    def _sample(self, nodes: np.ndarray, fanout: int):
        lo = self.indptr[nodes]
        hi = self.indptr[nodes + 1]
        deg = hi - lo
        # vectorized sampling with replacement
        total = int(np.maximum(deg, 1).sum()) if fanout < 0 else \
            int(len(nodes) * fanout)
        if fanout < 0:  # take all neighbors
            src_out, dst_out = [], []
            for n, l, h in zip(nodes, lo, hi):
                if h > l:
                    src_out.append(self.src[l:h])
                    dst_out.append(np.full(h - l, n))
            return (np.concatenate(src_out) if src_out else np.empty(0, np.int64),
                    np.concatenate(dst_out) if dst_out else np.empty(0, np.int64))
        reps = np.repeat(nodes, fanout)
        offsets = np.tile(np.arange(fanout), len(nodes))
        lo_r = np.repeat(lo, fanout)
        deg_r = np.repeat(deg, fanout)
        has = deg_r > 0
        pos = np.zeros(len(reps), dtype=np.int64)
        pos[has] = lo_r[has] + self.rng.integers(0, deg_r[has])
        return self.src[pos[has]], reps[has]

    def sample_blocks(self, seeds: np.ndarray, fanouts: list[int],
                      x_all: torch.Tensor):
        """Returns (x_tensor_for_batch, blocks, seed_local_indices).

        blocks are ordered layer-0 (outermost hop) first. Within each block's
        node set, the dst nodes occupy the first ``n_dst`` rows so that
        ``forward_blocks`` can slice self-features with ``h[:n_dst]``.
        """
        seeds = np.asarray(seeds)
        blocks = []
        layer_nodes = []  # node ids per layer input, innermost-last
        cur = np.unique(seeds)
        n_dst = len(cur)
        for fanout in reversed(fanouts):  # sample from last layer back
            s, d = self._sample(cur, fanout)
            # order-preserving unique with dst (cur) first
            all_nodes = np.concatenate([cur, s])
            uniq, first_idx = np.unique(all_nodes, return_index=True)
            src_nodes = uniq[np.argsort(first_idx, kind="stable")]
            node_map = {int(n): i for i, n in enumerate(src_nodes)}
            src_local = np.array([node_map[int(v)] for v in s], dtype=np.int64)
            dst_local = np.array([node_map[int(v)] for v in d], dtype=np.int64)
            blocks.append({"src_local": torch.from_numpy(src_local),
                           "dst_local": torch.from_numpy(dst_local),
                           "n_dst": n_dst})
            layer_nodes.append(src_nodes)
            cur = src_nodes
            n_dst = len(cur)
        blocks.reverse()
        layer_nodes.reverse()
        outer = layer_nodes[0] if layer_nodes else cur
        x = x_all[torch.from_numpy(outer)]
        inner = layer_nodes[-1]
        seed_map = {int(n): i for i, n in enumerate(inner)}
        seed_local = torch.tensor([seed_map[int(n)] for n in seeds],
                                  dtype=torch.long)
        return x, blocks, seed_local
