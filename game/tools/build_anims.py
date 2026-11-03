#!/usr/bin/env python3
"""Convert Unity Flash-animation bundles (PetAnimPackage/ppets_*) into web-friendly
sprite atlases + per-frame quad lists for game/site/anim/.

Each quad in the source is a textured rectangle under an affine transform. We repack the
distinct atlas regions into a small WebP and store every frame as
[piece, ux, uy, vx, vy, ox, oy, alpha, mode] (or [-1] = end of mask) (pixel units ×10 at 100 px per world unit).

Usage: python3 game/tools/build_anims.py [--force] [--jobs N] [bundle_id ...]
"""
import json, os, sys
from multiprocessing import Pool

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'SeerAPI/seer-unity-assets-pet_anim_part/newseer/assetbundles/PetAnimPackage')
OUT = os.path.join(ROOT, 'game/site/anim')
KEEP = ['standby', 'appear', 'attack', 'sa', 'hited']
# Materials live in a shared bundle that is not in the repo; their roles were inferred from
# usage patterns (mask-incr / masked / mask-decr triples, and soft bright pieces for glow).
# Render mode per quad: 0 normal, 1 additive, 2 mask shape, 3 masked, 4 masked additive.
MAT_MODE = {
    -8829651964785685189: 0, -8568644747829339649: 1, 3693667136763282965: 1,
    7822116813309631363: 2, -6851080937741916819: -1,
    5153968912407617786: 3, 5600891845394965287: 3,
    3268775101824798928: 4, 3865382328993057323: 4,
}
MASK_END = -1
SCALE = 0.5          # atlas downscale
MAX_ATLAS = 4096


def unpack_uv(p):
    return ((p >> 16) & 0xFFFF) / 65535, (p & 0xFFFF) / 65535


def unpack_alpha(p1):
    return (p1 & 0xFFFF) / 512


def pack_rects(sizes, width):
    """Shelf packing; returns positions and total height."""
    order = sorted(range(len(sizes)), key=lambda i: -sizes[i][1])
    pos = [None] * len(sizes)
    x = y = shelf = 0
    for i in order:
        w, h = sizes[i]
        if x + w > width:
            x, y, shelf = 0, y + shelf + 1, 0
        pos[i] = (x, y)
        x += w + 1
        shelf = max(shelf, h)
    return pos, y + shelf


FORCE = False


def convert(bid):
    import UnityPy
    from PIL import Image
    dst_json = os.path.join(OUT, f'{bid}.json')
    if os.path.exists(dst_json) and not FORCE:
        return bid, 'skip'
    env = UnityPy.load(os.path.join(SRC, f'ppets_{bid}'))
    clip = tex = None
    for o in env.objects:
        if o.type.name == 'MonoBehaviour':
            t = o.read_typetree()
            if 'Sequences' in t:
                clip = t
        elif o.type.name == 'Texture2D':
            tex = o.read()
    if not clip or not tex:
        return bid, 'no clip'
    img = tex.image
    W, H = img.size
    seqs = {s['Name']: s for s in clip['Sequences'] if s['Name'] in KEEP}
    if 'standby' not in seqs:
        return bid, 'no standby'

    pieces, piece_idx, out_seqs = [], {}, {}
    for name, s in seqs.items():
        frames, labels = [], {}
        for fi, fr in enumerate(s['Frames']):
            for lb in fr['Labels']:
                labels[lb] = fi
            md = fr['MeshData']
            V, UV, MC = md['Vertices'], md['UVs'], md['MulColors']
            quads = []
            for sm, mat in zip(md['SubMeshes'], fr['Materials']):
                mode = MAT_MODE.get(mat['m_PathID'], 0)
                if mode == MASK_END:
                    quads.append([MASK_END])
                    continue
                q0 = sm['StartVertex'] // 4
                for q in range(q0, q0 + sm['IndexCount'] // 6):
                    key = (UV[2 * q], UV[2 * q + 1])
                    if key not in piece_idx:
                        u0, v0 = unpack_uv(key[0]); u1, v1 = unpack_uv(key[1])
                        box = (int(u0 * W), int((1 - v1) * H), max(int(u0 * W) + 1, round(u1 * W)), max(int((1 - v1) * H) + 1, round((1 - v0) * H)))
                        piece_idx[key] = len(pieces)
                        pieces.append(box)
                    p0, p1, p3 = V[4 * q], V[4 * q + 1], V[4 * q + 3]
                    X = lambda p: p['x'] * 100
                    Y = lambda p: -p['y'] * 100
                    a = unpack_alpha(MC[2 * q + 1]) if 2 * q + 1 < len(MC) else 1
                    if a <= 0.01:
                        continue
                    quads.append([piece_idx[key],
                                  round((X(p1) - X(p0)) * 10), round((Y(p1) - Y(p0)) * 10),
                                  round((X(p0) - X(p3)) * 10), round((Y(p0) - Y(p3)) * 10),
                                  round(X(p3) * 10), round(Y(p3) * 10), round(min(a, 1) * 100), mode])
            frames.append(quads)
        out_seqs[name] = {'frames': frames, 'labels': labels}

    # repack atlas pieces
    crops = [img.crop(b) for b in pieces]
    scale = SCALE
    while True:
        sizes = [(max(1, round(c.width * scale)), max(1, round(c.height * scale))) for c in crops]
        pos, height = pack_rects(sizes, MAX_ATLAS)
        if height <= MAX_ATLAS:
            break
        scale *= 0.85
    atlas = Image.new('RGBA', (MAX_ATLAS, height + 1))
    for c, (w, h), (x, y) in zip(crops, sizes, pos):
        atlas.paste(c.resize((w, h), Image.LANCZOS), (x, y))
    bbox = atlas.getbbox() or (0, 0, 1, 1)
    atlas = atlas.crop((0, 0, bbox[2], bbox[3]))
    atlas.save(os.path.join(OUT, f'{bid}.webp'), 'WEBP', quality=80, method=6)

    # bounds from standby frames (px)
    xs, ys = [], []
    for quads in out_seqs['standby']['frames']:
        for q in quads:
            if len(q) < 9 or q[8] == 2:
                continue
            _, ux, uy, vx, vy, ox, oy = q[:7]
            for px, py in ((ox, oy), (ox + ux, oy + uy), (ox + vx, oy + vy), (ox + ux + vx, oy + uy + vy)):
                xs.append(px / 10); ys.append(py / 10)
    data = {'fps': clip['FrameRate'], 'pieces': [[x, y, w, h] for (x, y), (w, h) in zip(pos, sizes)],
            'bounds': [min(xs), min(ys), max(xs), max(ys)] if xs else [0, 0, 1, 1], 'seqs': out_seqs}
    with open(dst_json, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    return bid, f'ok pieces={len(pieces)} scale={scale:.2f}'


def pet_bundle_ids():
    """Bundles whose id is some pet's resource_id (skips collab/skin-only bundles)."""
    data = os.path.join(ROOT, 'SeerAPI/api-data/data/v1/data/pet')
    res = set()
    for d in os.listdir(data):
        if d.isdigit():
            with open(os.path.join(data, d, 'index.json'), encoding='utf-8') as f:
                res.add(str(json.load(f)['resource_id']))
    return [n[6:] for n in os.listdir(SRC) if n.startswith('ppets_') and n[6:] in res]


def main():
    args = sys.argv[1:]
    jobs = 4
    global FORCE
    if '--force' in args:
        FORCE = True
        args.remove('--force')
    if args[:1] == ['--jobs']:
        jobs, args = int(args[1]), args[2:]
    os.makedirs(OUT, exist_ok=True)
    ids = args or sorted(pet_bundle_ids())
    with Pool(jobs) as pool:
        for bid, msg in pool.imap_unordered(convert, ids):
            print(bid, msg, flush=True)


if __name__ == '__main__':
    main()
