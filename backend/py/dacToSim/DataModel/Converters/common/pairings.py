from dacToSim.constants.projectTypes import DAC, REMOTE_IO, LOGIC

equipment = [
  {DAC:	"DA_BKR",	LOGIC:	"SIM_BKR",	REMOTE_IO:	"SIM_BKR_REMOTE",	},
  {DAC:	"DA_CONTROL",	LOGIC:	"SIM_CONTROL",	REMOTE_IO:	"SIM_CONTROL_REMOTE",	},
  {DAC:	"DA_DAC_INTERCONNECT",	LOGIC:	"SIM_DAC_INTERCONNECT",	REMOTE_IO:	"SIM_DAC_INTERCONNECT_REMOTE",	},
  {DAC:	"DA_DAC_INTERCONNECT_MANAGER",	LOGIC:	"SIM_DAC_INTERCONNECT_MANAGER",	REMOTE_IO:	"SIM_DAC_INTERCONNECT_MANAGER_REMOTE",	},
  {DAC:	"DA_DG",	LOGIC:	"SIM_DG",	REMOTE_IO:	"SIM_DG_REMOTE",	},
  {DAC:	"DA_DUAL_SW",	LOGIC:	"SIM_DUAL_SW",	REMOTE_IO:	"SIM_DUAL_SW_REMOTE",	},
  {DAC:	"DA_FDR",	LOGIC:	"SIM_FDR",	REMOTE_IO:	"SIM_FDR_REMOTE",	},
  {DAC:	"DA_ManSw",	LOGIC:	"SIM_ManSw",	REMOTE_IO:	"SIM_ManSw_REMOTE",	},
  {DAC:	"DA_PSEUDO_BKR",	LOGIC:	"SIM_PSEUDO_BKR",	REMOTE_IO:	"SIM_PSEUDO_BKR_REMOTE",	},
  {DAC:	"DA_REC",	LOGIC:	"SIM_REC",	REMOTE_IO:	"SIM_REC_REMOTE",	},
  {DAC:	"DA_SUB_BUS",	LOGIC:	"SIM_SUB_BUS",	REMOTE_IO:	"SIM_SUB_BUS_REMOTE",	},
  {DAC:	"DA_SUB_MAIN",	LOGIC:	"SIM_SUB_MAIN",	REMOTE_IO:	"SIM_SUB_MAIN_REMOTE",	},
  {DAC:	"DA_SUB_TIE",	LOGIC:	"SIM_SUB_TIE",	REMOTE_IO:	"SIM_SUB_TIE_REMOTE",	},
  {DAC:	"DA_SUB_TRANSFORMER",	LOGIC:	"SIM_SUB_TRANSFORMER",	REMOTE_IO:	"SIM_SUB_TRANSFORMER_REMOTE",	},
  {DAC:	"DA_SW",	LOGIC:	"SIM_SW",	REMOTE_IO:	"SIM_SW_REMOTE",	},
  {DAC:	"DA_CAP",	LOGIC:	"SIM_CAP",	REMOTE_IO:	"SIM_CAP_REMOTE",	},
  {DAC:	"DA_REG",	LOGIC:	"SIM_REG",	REMOTE_IO:	"SIM_REG_REMOTE",	},
  {DAC:	"DA_JOIN",	LOGIC:	"SIM_JOIN",	REMOTE_IO:	"SIM_JOIN",	},
]

rowByName = {item[DAC]: item for item in equipment}
rowByName.update({item[LOGIC]: item for item in equipment})
rowByName.update({item[REMOTE_IO]: item for item in equipment})


def getPairing(deviceType: str, projectType: str) -> str:
  activeRow = rowByName.get(deviceType, None)
  if not activeRow:
    raise ValueError(f"Device type '{deviceType}' not found in pairings.")
  if projectType not in activeRow:
    raise ValueError(f"Project type '{projectType}' not found for device type '{deviceType}'.")
  return activeRow[projectType]