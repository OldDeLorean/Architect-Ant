# Architect-Ant: Editable Automatic Furnishing of Architectural Floor Plans

Project page: **https://olddelorean.github.io/Architect-Ant/**

Fedor Rodionov, Aleksandar Cvejić, Michael Birsak, John Femiani, Peter Wonka

[Paper (arXiv)](https://arxiv.org/pdf/2606.10953) · [AntPlan dataset](https://huggingface.co/datasets/OldDelorean/AntPlan)

This repository holds the static project page: interactive 3D comparisons of furnished SS109 rooms and whole houses,
rendered from the scenes used in the paper. It has no build step; three.js loads from a CDN.

## Preview locally

The page fetches `.glb` and `.json` files, so serve it over HTTP (opening `index.html` from disk will not work):

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Citation

```bibtex
@article{rodionov2026architectant,
  title   = {Architect-Ant: Editable Automatic Furnishing of Architectural Floor Plans},
  author  = {Rodionov, Fedor and Cveji{\'c}, Aleksandar and Birsak, Michael and
             Femiani, John and Wonka, Peter},
  journal = {arXiv preprint arXiv:2606.10953},
  year    = {2026}
}
```
