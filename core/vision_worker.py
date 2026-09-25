"""Persistent local detector. JSON lines over stdin/stdout; no screen or network access."""
import base64
import contextlib
import io
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault('YOLO_CONFIG_DIR', str(ROOT / 'work' / 'ultralytics'))
Path(os.environ['YOLO_CONFIG_DIR']).mkdir(parents=True, exist_ok=True)
os.environ.setdefault('YOLO_AUTOINSTALL', 'false')
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

def respond(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)

def main():
    model_path = Path(os.getenv('IANA_VISION_MODEL', str(ROOT / 'models' / 'yolo26n.pt')))
    if not model_path.is_file():
        respond({'event':'error','error':'Modelo local ausente. Execute npm run vision:setup.'})
        return
    with contextlib.redirect_stdout(sys.stderr):
        import cv2
        import numpy as np
        import torch
        from ultralytics import YOLO
        model = YOLO(str(model_path))
        device = '0' if torch.cuda.is_available() else 'cpu'
        model.predict(np.zeros((384, 640, 3), dtype=np.uint8), imgsz=640, device=device, verbose=False)
    respond({'event':'ready','model':model_path.name,'device':device,'scope':'generic-object-detection'})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            started = time.perf_counter()
            raw = base64.b64decode(request['image'], validate=True)
            if len(raw) > 2_000_000:
                raise ValueError('Imagem maior que 2 MB.')
            frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None or frame.shape[0] * frame.shape[1] > 3_000_000:
                raise ValueError('Imagem inválida ou resolução excessiva.')
            with contextlib.redirect_stdout(sys.stderr):
                result = model.predict(frame, imgsz=640, conf=0.4, max_det=40, device=device, verbose=False)[0]
            boxes = []
            for box in result.boxes:
                boxes.append({'label':result.names[int(box.cls.item())], 'confidence':round(float(box.conf.item()),3), 'xyxy':[round(float(v),1) for v in box.xyxy[0].tolist()]})
            respond({'id':request['id'],'detections':boxes,'width':frame.shape[1],'height':frame.shape[0],'inferenceMs':round((time.perf_counter()-started)*1000,1),'device':device})
        except Exception as exc:
            respond({'id':request.get('id'),'error':str(exc)[:250]})

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        respond({'event':'error','error':str(exc)[:250]})
