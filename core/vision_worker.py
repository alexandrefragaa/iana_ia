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


def summarize_scene(detections):
    """Transforma objetos detectados em um resumo estruturado para o guia do jogador."""
    if not isinstance(detections, list):
        return {
            'status': 'sem_dados',
            'risk': 'baixa',
            'route': 'esperar e reagrupar',
            'items': [],
            'decision': 'Ainda não há elementos suficientes para sugerir uma rota.',
            'summary': 'A cena ainda não está clara o bastante para orientar a próxima ação.'
        }

    labels = []
    for detection in detections:
        if not isinstance(detection, dict):
            continue
        label = str(detection.get('label', '')).strip().lower()
        if label:
            labels.append(label)

    dangerous = {'enemy', 'monster', 'boss', 'danger', 'trap', 'hazard', 'fire', 'spikes'}
    items = {'chest', 'coin', 'potion', 'key', 'ammo', 'weapon', 'sword', 'shield', 'armor', 'health', 'item'}
    routes = {'door', 'stairs', 'portal', 'exit', 'path', 'checkpoint'}

    detected_items = sorted({label for label in labels if label in items})
    detected_danger = sorted({label for label in labels if label in dangerous})
    detected_routes = sorted({label for label in labels if label in routes})

    if detected_danger:
        status = 'perigoso'
        risk = 'alta'
        route = 'evite a rota frontal, mantenha cobertura e procure uma trilha lateral segura.'
        decision = 'Há ameaça visível. Recuar, se posicionar melhor ou desviar para uma rota lateral.'
    elif detected_items:
        status = 'explorar'
        risk = 'média'
        route = 'avance em direção ao item útil mais próximo e confirme a rota antes do próximo encontro.'
        decision = 'Há recursos visíveis. Coletar o útil agora pode compensar o risco da próxima área.'
    elif detected_routes:
        status = 'transitar'
        risk = 'baixa'
        route = 'siga pela referência de caminho mais clara e confirme se a área está livre.'
        decision = 'Sem ameaça evidente. Use a rota visível como referência e avance com calma.'
    else:
        status = 'seguro'
        risk = 'baixa'
        route = 'faça uma varredura curta, confirme bordas e só avance se abrir espaço.'
        decision = 'Cena está relativamente estável. Faça uma observação rápida antes de seguir.'

    if detected_routes:
        route = f"{route} Referência: {', '.join(detected_routes)}."
    if detected_items:
        decision = f"{decision} Itens relevantes: {', '.join(detected_items)}."
    if detected_danger:
        decision = f"{decision} Perigos: {', '.join(detected_danger)}."

    return {
        'status': status,
        'risk': risk,
        'route': route,
        'items': detected_items,
        'decision': decision,
        'summary': f"Cena em estado {status}. Risco {risk}. {decision}"
    }


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
            scene = summarize_scene(boxes)
            respond({'id':request['id'],'detections':boxes,'width':frame.shape[1],'height':frame.shape[0],'inferenceMs':round((time.perf_counter()-started)*1000,1),'device':device,'summary':scene})
        except Exception as exc:
            respond({'id':request.get('id'),'error':str(exc)[:250]})

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        respond({'event':'error','error':str(exc)[:250]})
