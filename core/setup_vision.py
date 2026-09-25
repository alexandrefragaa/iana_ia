"""Download official YOLO26 nano weights once, then inference works offline."""
import os
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
os.environ['YOLO_CONFIG_DIR']=str(ROOT/'work'/'ultralytics')
Path(os.environ['YOLO_CONFIG_DIR']).mkdir(parents=True, exist_ok=True)
os.environ['YOLO_AUTOINSTALL']='false'
if __name__=='__main__':
    target=ROOT/'models';target.mkdir(exist_ok=True)
    os.chdir(target)
    from ultralytics import YOLO
    model=YOLO('yolo26n.pt')
    print('Modelo pronto:',target/'yolo26n.pt')
