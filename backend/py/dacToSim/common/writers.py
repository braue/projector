from pathlib import Path
import time

def writeFile(destFile, body, overwrite=True, retries=3, delay=0.5):
  if len(body) == 0:
    print(f"Attempting to write empty file at\n\t{destFile}")
  
  destFile = Path(destFile)
  destFile.parents[0].mkdir(parents=True, exist_ok=True)
  attempt = 0
  while attempt < retries:
      try:
          if destFile.exists() and not overwrite:
              return
          if destFile.exists():
              destFile.unlink(True)
          destFile.write_text(body)
          break
      except PermissionError as e:
          attempt += 1
          #print(f"PermissionError writing {destFile}, retry {attempt}/{retries}")
          time.sleep(delay)
  else:
      raise PermissionError(f"Failed to write {destFile} after {retries} retries.")