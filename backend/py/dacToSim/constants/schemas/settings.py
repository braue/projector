SCHEME_NAME = 'schemeName'

SIM_ID = 'subSimId'


DAC = 'dac'
SIM_MASTER = 'logic'
SIM_IO = 'remote'
FOLDER_NAME = 'subFolder'
IP_ADDR = 'ipAddr'


NAME_CONVERSIONS = "nameConversions"
OLD = 'old'
NEW = 'new'


PARAMETERS = 'parameters'

DEFAULT_LOAD = 'defaultLoad'


EXAMPLE = [
  {
    SCHEME_NAME:'',
    SIM_ID:'',
    DAC:{
      FOLDER_NAME:'',
      IP_ADDR:['']
    },
    SIM_IO:{
      FOLDER_NAME:'',
      IP_ADDR:''
    },
    SIM_MASTER:{
      FOLDER_NAME:'',
      IP_ADDR:''
    },
    NAME_CONVERSIONS:[
       {OLD:'',NEW:''}
    ],
    PARAMETERS:{
      DEFAULT_LOAD:0
    }
  }
]
