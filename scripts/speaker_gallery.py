#!/usr/bin/env python3
"""
声纹库：两阶段交付
  阶段一：自动推断 spk0/spk1/spk2...
  阶段二：用户确认姓名后，存入库，下次会议自动匹配

数据文件：data/speakers/speaker_gallery.json
  {
    "speakers": [
      { "id": "spk_xxx", "name": "冠然总", "embedding": [...] }
    ]
  }
"""
import json
import numpy as np
from pathlib import Path

GALLERY_PATH = Path(__file__).resolve().parent.parent / "data" / "speakers" / "speaker_gallery.json"

def load_gallery():
    if not GALLERY_PATH.exists():
        GALLERY_PATH.parent.mkdir(parents=True, exist_ok=True)
        return {"speakers": []}
    return json.loads(GALLERY_PATH.read_text())

def save_gallery(gallery):
    GALLERY_PATH.parent.mkdir(parents=True, exist_ok=True)
    GALLERY_PATH.write_text(json.dumps(gallery, ensure_ascii=False, indent=2))

def add_speaker(name, embedding):
    gallery = load_gallery()
    sid = f"spk_{len(gallery['speakers'])+1:03d}"
    gallery["speakers"].append({
        "id": sid,
        "name": name,
        "embedding": embedding.tolist() if isinstance(embedding, np.ndarray) else embedding
    })
    save_gallery(gallery)
    return sid

def find_speaker(embedding, threshold=0.7):
    """返回 (speaker_id, name, distance) 或 (None, None, 1.0)"""
    gallery = load_gallery()
    if not gallery["speakers"]:
        return None, None, 1.0
    best_id, best_name, best_dist = None, None, 1.0
    for spk in gallery["speakers"]:
        emb = np.array(spk["embedding"])
        dist = 1 - np.dot(embedding, emb) / (np.linalg.norm(embedding) * np.linalg.norm(emb))
        if dist < best_dist:
            best_dist = dist
            best_id = spk["id"]
            best_name = spk["name"]
    if best_dist < threshold:
        return best_id, best_name, best_dist
    return None, None, best_dist

if __name__ == "__main__":
    # CLI 测试
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "list":
        g = load_gallery()
        print(f"声纹库共 {len(g['speakers'])} 人：")
        for s in g["speakers"]:
            print(f"  {s['id']}: {s['name']}")
