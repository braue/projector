from collections.abc import Mapping

class PropertyMapping(Mapping):
  def __init__(self, obj):
    self._obj = obj

  def __getitem__(self, key):
    value = getattr(self._obj, key)
    if hasattr(value, '__dict__'):
      return PropertyMapping(value)
    return value

  def __iter__(self):
    return (key for key in dir(self._obj) if not key.startswith('_') and not callable(getattr(self._obj, key)))

  def __len__(self):
    return len([key for key in dir(self._obj) if not key.startswith('_') and not callable(getattr(self._obj, key))])

# Example classes with nested properties
class Inner:
  def __init__(self, x):
    self.x = x

class Outer:
  def __init__(self, a, b):
    self.a = a
    self.b = Inner(b)

