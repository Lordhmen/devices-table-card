import json,re
# extract previous script from transcript
lines=open('/root/.claude/projects/-home-claude/a8cfa911-84cf-5863-90a3-ead69e140f2b.jsonl').read().splitlines()
for l in reversed(lines):
    if 'Implement show_all for availability mode' in l:
        d=json.loads(l); break
for c in d['message']['content']:
    if c.get('type')=='tool_use': cmd=c['input']['command']
py=cmd.split("<<'E'\n",1)[1].split("\nE\n",1)[0]
py=py.replace("""rep(\"\"\"          @container (max-width: 560px) { .c-mac { display: none; } }\"\"\",\"\"\"          @container (max-width: 560px) { .c-mac, .c-dur { display: none; } }\"\"\")""",
 """rep(\"\"\"        @container (max-width: 560px) { .c-mac { display: none; } }\"\"\",\"\"\"        @container (max-width: 560px) { .c-mac, .c-dur { display: none; } }\"\"\")""")
open('patch_showall.py','w').write(py)