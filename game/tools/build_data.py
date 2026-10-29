#!/usr/bin/env python3
"""Pack SeerAPI data + images into game/site/ for the standalone web game.

Usage: python3 game/tools/build_data.py [max_pet_id]
"""
import json, os, sys
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DATA = os.path.join(ROOT, 'SeerAPI/api-data/data/v1/data')
IMG = os.path.join(ROOT, 'SeerAPI/seer-unity-assets/newseer/assets/art/ui/assets/pet')
OUT = os.path.join(ROOT, 'game/site')
MAX_ID = int(sys.argv[1]) if len(sys.argv) > 1 else 300
# effect ids the battle engine understands
EFFECTS = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 29, 31}


def load(kind, i):
    p = os.path.join(DATA, kind, str(i), 'index.json')
    if not os.path.exists(p):
        return None
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def stats(s):
    return [s['hp'], s['atk'], s['def'], s['sp_atk'], s['sp_def'], s['spd']]


def main():
    os.makedirs(os.path.join(OUT, 'img/body'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'img/head'), exist_ok=True)

    types = {}
    for i in range(1, 300):
        t = load('element_type', i)
        if t:
            types[i] = {'name': t['name'], 'rel': {r['target_type']['id']: r['multiple'] for r in t['relations']}}
    combos = {}
    for d in os.listdir(os.path.join(DATA, 'element_type_combination')):
        if d.isdigit():
            c = load('element_type_combination', d)
            combos[c['id']] = {'name': c['name'], 't': [c['primary']['id']] + ([c['secondary']['id']] if c['secondary'] else [])}

    natures = []
    for d in sorted(os.listdir(os.path.join(DATA, 'nature'))):
        if d.isdigit():
            n = load('nature', d)
            a = n['attributes']
            natures.append({'name': n['name'], 'des': n['des2'], 'm': [0, a['atk'], a['def'], a['sp_atk'], a['sp_def'], a['spd']]})

    pets, skills, classes = {}, {}, {}
    for i in range(1, MAX_ID + 1):
        p = load('pet', i)
        if not p or p['type']['id'] not in combos:
            continue
        body = os.path.join(IMG, 'body', f'{i}.png')
        head = os.path.join(IMG, 'head', f'{i}.png')
        if not (os.path.exists(body) and os.path.exists(head)):
            continue
        learn = []
        for s in p['skill']:
            sid = s['skill']['id']
            if s['learning_level'] > 100 or s['is_fifth'] or s['skill_activation_item']:
                continue
            if sid not in skills:
                sk = load('skill', sid)
                if not sk or sk['type']['id'] not in combos:
                    continue
                skills[sid] = {
                    'name': sk['name'], 'pow': sk['power'] or 0, 'pp': sk['max_pp'] or 10,
                    'acc': sk['accuracy'] or 100, 'crit': sk['crit_rate'] or 0, 'pri': sk['priority'] or 0,
                    'hit': sk['must_hit'], 'cat': sk['category']['id'], 'type': sk['type']['id'],
                    'fx': [[e['effect']['id'], e['args']] for e in sk['skill_effect'] if e['effect']['id'] in EFFECTS],
                    'info': '；'.join(e['info'] for e in sk['skill_effect']) or (sk['info'] or ''),
                }
            learn.append([s['learning_level'], sid])
        if not learn:
            continue
        pc = load('pet_class', p['pet_class']['id'])
        chain = [c['id'] for c in pc['evolution_chain']] if pc else [i]
        nxt = None
        if i in chain and chain.index(i) + 1 < len(chain) and p['evolving_lv']:
            nxt = chain[chain.index(i) + 1]
        rare = bool(pc and (pc['is_rare_pet'] or pc['is_shine_pet'] or pc['is_dark_pet'] or pc['is_variant_pet']))
        pets[i] = {
            'name': p['name'], 'type': p['type']['id'], 'base': stats(p['base_stats']),
            'exp': p['yielding_exp'], 'catch': p['catch_rate'], 'evo': [p['evolving_lv'], nxt] if nxt else None,
            'learn': sorted(learn), 'first': chain[0] == i, 'rare': rare,
        }
        for kind, src, size in (('body', body, 260), ('head', head, 96)):
            dst = os.path.join(OUT, 'img', kind, f'{i}.webp')
            if not os.path.exists(dst):
                im = Image.open(src).convert('RGBA')
                im.thumbnail((size, size))
                im.save(dst, 'WEBP', quality=82, method=6)
    # drop evolutions pointing outside the packed set
    for p in pets.values():
        if p['evo'] and p['evo'][1] not in pets:
            p['evo'] = None
    used = {c for p in pets.values() for c in [p['type']]} | {s['type'] for s in skills.values()}
    combos = {k: v for k, v in combos.items() if k in used}
    out = {'types': types, 'combos': combos, 'natures': natures, 'pets': pets, 'skills': skills}
    with open(os.path.join(OUT, 'data.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'pets={len(pets)} skills={len(skills)} combos={len(combos)}')


if __name__ == '__main__':
    main()
