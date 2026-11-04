#!/usr/bin/env python3
"""Opt-in disposable interactive Claude hook probe. No persistent configuration edits.
Run: python3 claude_probe.py. Artifacts stay in printed /tmp directory.
Only model action requested is text output; all model tools are disabled.
"""
import fcntl,json,os,pathlib,pty,re,select,signal,struct,subprocess,sys,tempfile,time

def log(root,**data):
    with (root/'events.jsonl').open('a') as f: f.write(json.dumps({'at':time.time(),**data})+'\n')

def hook(root,mode):
    data=json.load(sys.stdin)
    log(root,event=data.get('hook_event_name'),mode=mode,session=data.get('session_id'),transcript=data.get('transcript_path'),stop_active=data.get('stop_hook_active'))
    if mode=='watch':
        with (root/'watch.lock').open('w') as lock:
            try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: return
            log(root,watch='armed')
            end=time.time()+180
            while time.time()<end and not (root/'shutdown').exists():
                mails=sorted(root.glob('mail-*.txt'))
                if mails:
                    text=mails[0].read_text(); mails[0].rename(mails[0].with_suffix('.delivered'))
                    log(root,delivered=text)
                    print('Intercom probe message. Reply with exactly '+text+' and no other text.',file=sys.stderr,flush=True)
                    sys.exit(2)
                time.sleep(.1)
            log(root,watch='expired')

if len(sys.argv)>1 and sys.argv[1]=='--hook':
    hook(pathlib.Path(sys.argv[2]),sys.argv[3]); sys.exit(0)
root=pathlib.Path(tempfile.mkdtemp(prefix='hc-claude-probe-'))
script=str(pathlib.Path(__file__).resolve())
settings={'hooks':{}}
for event in ('SessionStart','Stop'):
    settings['hooks'][event]=[{'hooks':[{'type':'command','command':sys.executable,'args':[script,'--hook',str(root),'watch'],'asyncRewake':True,'timeout':190}]}]
for event in ('UserPromptSubmit','StopFailure'):
    settings['hooks'][event]=[{'hooks':[{'type':'command','command':sys.executable,'args':[script,'--hook',str(root),'log']}]}]
(root/'settings.json').write_text(json.dumps(settings))
master,slave=pty.openpty(); fcntl.ioctl(slave,0x5414,struct.pack('HHHH',40,140,0,0))
args=['claude','--settings',str(root/'settings.json'),'--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','','--model','haiku','--permission-mode','default','--append-system-prompt','This is a disposable messaging test. Do not perform actions. Reply to nonce messages exactly as requested.']
env=dict(os.environ,TERM='xterm-256color'); env.pop('CLAUDECODE',None)
p=subprocess.Popen(args,cwd=root,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True); os.close(slave)
print(root,flush=True)
buf=bytearray()
def pump(seconds):
    end=time.time()+seconds
    while time.time()<end and p.poll() is None:
        if select.select([master],[],[],min(.2,max(0,end-time.time())))[0]:
            try: chunk=os.read(master,65536)
            except OSError: break
            buf.extend(chunk)
            with (root/'terminal.raw').open('ab') as f:f.write(chunk)
def events():
    try:return [json.loads(x) for x in (root/'events.jsonl').read_text().splitlines()]
    except FileNotFoundError:return []
def send(text):
    os.write(master,text.encode());pump(.3);os.write(master,b'\r');log(root,sent=text)
def mail(n):
    text='ACK_'+n+'_'+root.name[-6:];(root/('mail-'+n+'.txt')).write_text(text);log(root,enqueued=text);return text
try:
    pump(5)
    if 'Itrustthisfolder' in re.sub(r'\s+', '', re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', bytes(buf).decode(errors='replace'))):
        os.write(master,b'\x1b[B\r');log(root,onboarding='trusted only generated scratch directory');pump(6)
    # Only handle trust/color onboarding within this disposable child.
    (root/'startup-tail.txt').write_bytes(bytes(buf[-12000:]))
    print('STARTUP_CAPTURED',flush=True)
    # Continue automatically only when Claude has begun our SessionStart watcher.
    if not any(e.get('watch')=='armed' for e in events()):
        print('BLOCKED_STARTUP; inspect startup-tail.txt; no input sent',flush=True)
    else:
        send('Reply with exactly READY_PROBE and no other text.')
        pump(12)
        a=mail('idle1');pump(15)
        b=mail('idle2');pump(15)
        send('Print the integers from 1 through 200, one per line, without using tools.')
        pump(.3);c=mail('busy3');pump(25)
        ev=events()
        transcripts={e['transcript'] for e in ev if e.get('transcript')}
        assistant=[]
        for path in transcripts:
            for line in pathlib.Path(path).read_text().splitlines():
                record=json.loads(line)
                if record.get('type')=='assistant':
                    assistant.append({'timestamp':record.get('timestamp'),'text':''.join(part.get('text','') for part in record.get('message',{}).get('content',[]) if part.get('type')=='text')})
        checks={nonce:any(item['text']==nonce for item in assistant) for nonce in [a,b,c]}
        checks['busy_prompt_submitted']=sum(e.get('event')=='UserPromptSubmit' for e in ev)>=5
        checks['busy_response_completed']=any(item['text']=='\n'.join(map(str,range(1,201))) for item in assistant)
        (root/'summary.json').write_text(json.dumps({'events':ev,'nonces':[a,b,c],'assistant':assistant,'checks':checks,'claude_exit':p.poll()},indent=2))
        print(json.dumps(checks),flush=True)
        if not all(checks.values()):sys.exit(1)
        print('COMPLETE',flush=True)
finally:
    (root/'shutdown').touch()
    if p.poll() is None:
        os.killpg(p.pid,signal.SIGTERM)
        try:p.wait(timeout=5)
        except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
    os.close(master)
