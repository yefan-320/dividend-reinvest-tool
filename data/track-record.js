// 历史战绩静态数据（自动生成 2026-08-18；口径见 track-note）
// 29只×16年真实日K+分红；工具当前线打标；分红复投；样本内校准口径
(function(root){
const TRACK_DATA = {
 "gen": "2026-08-18",
 "note": "29只×16年真实日K+分红；工具当前线打标；分红复投；样本内校准口径（2026线回看历史），滚动500天无未来函数交叉验证一致",
 "tiers": {
  "all": {
   "small": {
    "r1": {
     "n": 8166,
     "mid": 7.5,
     "loss": 36
    },
    "r3": {
     "n": 5605,
     "mid": 39.5,
     "loss": 14
    },
    "r5": {
     "n": 4134,
     "mid": 65.8,
     "loss": 3
    }
   },
   "add": {
    "r1": {
     "n": 3530,
     "mid": 8.9,
     "loss": 25
    },
    "r3": {
     "n": 2641,
     "mid": 47.6,
     "loss": 9
    },
    "r5": {
     "n": 1896,
     "mid": 87.2,
     "loss": 10
    }
   },
   "heavy": {
    "r1": {
     "n": 14404,
     "mid": 22.5,
     "loss": 17
    },
    "r3": {
     "n": 12496,
     "mid": 65.1,
     "loss": 10
    },
    "r5": {
     "n": 7867,
     "mid": 89.5,
     "loss": 6
    }
   }
  },
  "bank": {
   "small": {
    "r1": {
     "n": 2019,
     "mid": 5.7,
     "loss": 34
    },
    "r3": {
     "n": 1420,
     "mid": 34.4,
     "loss": 3
    },
    "r5": {
     "n": 1153,
     "mid": 63.1,
     "loss": 4
    }
   },
   "add": {
    "r1": {
     "n": 2311,
     "mid": 5.4,
     "loss": 28
    },
    "r3": {
     "n": 1765,
     "mid": 48.3,
     "loss": 8
    },
    "r5": {
     "n": 1325,
     "mid": 89.7,
     "loss": 11
    }
   },
   "heavy": {
    "r1": {
     "n": 4733,
     "mid": 28.3,
     "loss": 9
    },
    "r3": {
     "n": 3916,
     "mid": 80.9,
     "loss": 8
    },
    "r5": {
     "n": 1982,
     "mid": 95.6,
     "loss": 9
    }
   }
  },
  "consumer": {
   "small": {
    "r1": {
     "n": 1077,
     "mid": 9.3,
     "loss": 31
    },
    "r3": {
     "n": 502,
     "mid": 57.6,
     "loss": 5
    },
    "r5": {
     "n": 448,
     "mid": 209.7,
     "loss": 4
    }
   },
   "add": {
    "r1": {
     "n": 214,
     "mid": 20.1,
     "loss": 16
    },
    "r3": {
     "n": 173,
     "mid": 40.2,
     "loss": 10
    },
    "r5": {
     "n": 153,
     "mid": 74.6,
     "loss": 7
    }
   },
   "heavy": {
    "r1": {
     "n": 1706,
     "mid": 17.3,
     "loss": 21
    },
    "r3": {
     "n": 1520,
     "mid": 69.2,
     "loss": 5
    },
    "r5": {
     "n": 933,
     "mid": 172.1,
     "loss": 3
    }
   }
  },
  "insurer": {
   "small": {
    "r1": {
     "n": 2123,
     "mid": 18.6,
     "loss": 31
    },
    "r3": {
     "n": 1691,
     "mid": 36.9,
     "loss": 25
    },
    "r5": {
     "n": 1244,
     "mid": 39.9,
     "loss": 1
    }
   },
   "add": {
    "r1": {
     "n": 287,
     "mid": 16.2,
     "loss": 17
    },
    "r3": {
     "n": 254,
     "mid": 46,
     "loss": 10
    },
    "r5": {
     "n": 154,
     "mid": 34.5,
     "loss": 0
    }
   },
   "heavy": {
    "r1": {
     "n": 1353,
     "mid": 21.3,
     "loss": 31
    },
    "r3": {
     "n": 1039,
     "mid": 41.9,
     "loss": 21
    },
    "r5": {
     "n": 523,
     "mid": 47.6,
     "loss": 4
    }
   }
  },
  "utility": {
   "small": {
    "r1": {
     "n": 2006,
     "mid": 2,
     "loss": 46
    },
    "r3": {
     "n": 1536,
     "mid": 38.5,
     "loss": 12
    },
    "r5": {
     "n": 1109,
     "mid": 74.5,
     "loss": 6
    }
   },
   "add": {
    "r1": {
     "n": 356,
     "mid": 9.6,
     "loss": 26
    },
    "r3": {
     "n": 304,
     "mid": 38,
     "loss": 13
    },
    "r5": {
     "n": 215,
     "mid": 86.2,
     "loss": 19
    }
   },
   "heavy": {
    "r1": {
     "n": 4283,
     "mid": 20.3,
     "loss": 17
    },
    "r3": {
     "n": 4024,
     "mid": 50.2,
     "loss": 9
    },
    "r5": {
     "n": 3237,
     "mid": 92.3,
     "loss": 7
    }
   }
  },
  "energy": {
   "small": {
    "r1": {
     "n": 941,
     "mid": 10.1,
     "loss": 35
    },
    "r3": {
     "n": 456,
     "mid": 62.9,
     "loss": 21
    },
    "r5": {
     "n": 180,
     "mid": 259.6,
     "loss": 0
    }
   },
   "add": {
    "r1": {
     "n": 362,
     "mid": 32.2,
     "loss": 10
    },
    "r3": {
     "n": 145,
     "mid": 73.1,
     "loss": 4
    },
    "r5": null
   },
   "heavy": {
    "r1": {
     "n": 2329,
     "mid": 25.8,
     "loss": 25
    },
    "r3": {
     "n": 1997,
     "mid": 69,
     "loss": 18
    },
    "r5": {
     "n": 1192,
     "mid": 84.2,
     "loss": 0
    }
   }
  },
  "telecom": {
   "small": {
    "r1": null,
    "r3": null,
    "r5": null
   },
   "add": {
    "r1": null,
    "r3": null,
    "r5": null
   },
   "heavy": {
    "r1": null,
    "r3": null,
    "r5": null
   }
  }
 },
 "waitGap": {
  "all": {
   "near": {
    "r1": {
     "n": 11511,
     "mid": 2.1,
     "loss": 46
    },
    "r3": {
     "n": 7919,
     "mid": 19.3,
     "loss": 31
    },
    "r5": {
     "n": 6971,
     "mid": 50.5,
     "loss": 10
    }
   },
   "mid": {
    "r1": {
     "n": 32894,
     "mid": 3.9,
     "loss": 43
    },
    "r3": {
     "n": 28657,
     "mid": 19.4,
     "loss": 34
    },
    "r5": {
     "n": 25306,
     "mid": 39.5,
     "loss": 20
    }
   },
   "far": {
    "r1": {
     "n": 30927,
     "mid": -2.8,
     "loss": 54
    },
    "r3": {
     "n": 30114,
     "mid": 1.2,
     "loss": 49
    },
    "r5": {
     "n": 27258,
     "mid": 26.8,
     "loss": 34
    }
   }
  },
  "bank": {
   "near": {
    "r1": {
     "n": 4873,
     "mid": 4.7,
     "loss": 38
    },
    "r3": {
     "n": 3836,
     "mid": 20,
     "loss": 20
    },
    "r5": {
     "n": 3607,
     "mid": 54.6,
     "loss": 1
    }
   },
   "mid": {
    "r1": {
     "n": 8882,
     "mid": 1.8,
     "loss": 46
    },
    "r3": {
     "n": 7995,
     "mid": 8.5,
     "loss": 40
    },
    "r5": {
     "n": 7491,
     "mid": 29.5,
     "loss": 23
    }
   },
   "far": {
    "r1": {
     "n": 6973,
     "mid": -6.1,
     "loss": 62
    },
    "r3": {
     "n": 6859,
     "mid": -2.6,
     "loss": 54
    },
    "r5": {
     "n": 6233,
     "mid": 19.6,
     "loss": 35
    }
   }
  },
  "consumer": {
   "near": {
    "r1": {
     "n": 1720,
     "mid": 8.9,
     "loss": 35
    },
    "r3": {
     "n": 960,
     "mid": 54,
     "loss": 9
    },
    "r5": {
     "n": 781,
     "mid": 156,
     "loss": 7
    }
   },
   "mid": {
    "r1": {
     "n": 10750,
     "mid": 12.2,
     "loss": 36
    },
    "r3": {
     "n": 8840,
     "mid": 42.7,
     "loss": 27
    },
    "r5": {
     "n": 7276,
     "mid": 84.6,
     "loss": 10
    }
   },
   "far": {
    "r1": {
     "n": 9791,
     "mid": 0.4,
     "loss": 49
    },
    "r3": {
     "n": 9763,
     "mid": -1.2,
     "loss": 51
    },
    "r5": {
     "n": 8667,
     "mid": 15.6,
     "loss": 35
    }
   }
  },
  "insurer": {
   "near": {
    "r1": {
     "n": 1512,
     "mid": -5.2,
     "loss": 59
    },
    "r3": {
     "n": 932,
     "mid": 12.1,
     "loss": 43
    },
    "r5": {
     "n": 626,
     "mid": 31.3,
     "loss": 12
    }
   },
   "mid": {
    "r1": {
     "n": 3654,
     "mid": -2.6,
     "loss": 54
    },
    "r3": {
     "n": 3513,
     "mid": 12.3,
     "loss": 37
    },
    "r5": {
     "n": 3382,
     "mid": 27,
     "loss": 26
    }
   },
   "far": {
    "r1": {
     "n": 2321,
     "mid": 2.2,
     "loss": 47
    },
    "r3": {
     "n": 2321,
     "mid": 3,
     "loss": 47
    },
    "r5": {
     "n": 2321,
     "mid": 20.7,
     "loss": 41
    }
   }
  },
  "utility": {
   "near": {
    "r1": {
     "n": 2844,
     "mid": -2.9,
     "loss": 58
    },
    "r3": {
     "n": 1930,
     "mid": -14.9,
     "loss": 59
    },
    "r5": {
     "n": 1773,
     "mid": 23.9,
     "loss": 30
    }
   },
   "mid": {
    "r1": {
     "n": 5420,
     "mid": 0.8,
     "loss": 48
    },
    "r3": {
     "n": 4615,
     "mid": 24.4,
     "loss": 40
    },
    "r5": {
     "n": 3947,
     "mid": 54.1,
     "loss": 20
    }
   },
   "far": {
    "r1": {
     "n": 2422,
     "mid": -10.6,
     "loss": 66
    },
    "r3": {
     "n": 2422,
     "mid": 38.7,
     "loss": 30
    },
    "r5": {
     "n": 2050,
     "mid": 78,
     "loss": 7
    }
   }
  },
  "energy": {
   "near": {
    "r1": {
     "n": 562,
     "mid": 6.5,
     "loss": 40
    },
    "r3": {
     "n": 261,
     "mid": 37.7,
     "loss": 30
    },
    "r5": {
     "n": 184,
     "mid": 32.6,
     "loss": 0
    }
   },
   "mid": {
    "r1": {
     "n": 4188,
     "mid": 5.5,
     "loss": 39
    },
    "r3": {
     "n": 3694,
     "mid": 22.7,
     "loss": 27
    },
    "r5": {
     "n": 3210,
     "mid": 12.3,
     "loss": 29
    }
   },
   "far": {
    "r1": {
     "n": 9420,
     "mid": -1.7,
     "loss": 52
    },
    "r3": {
     "n": 8749,
     "mid": 1.5,
     "loss": 49
    },
    "r5": {
     "n": 7987,
     "mid": 47.3,
     "loss": 36
    }
   }
  },
  "telecom": {
   "near": {
    "r1": null,
    "r3": null,
    "r5": null
   },
   "mid": {
    "r1": null,
    "r3": null,
    "r5": null
   },
   "far": {
    "r1": null,
    "r3": null,
    "r5": null
   }
  }
 },
 "waitDur": {
  "all": {
   "near": {
    "n": 569,
    "p50": 3,
    "p90": 86
   },
   "mid": {
    "n": 42,
    "p50": 136,
    "p90": 733
   },
   "far": {
    "n": 33,
    "p50": 612,
    "p90": 2420
   }
  },
  "bank": {
   "near": {
    "n": 155,
    "p50": 5,
    "p90": 107
   },
   "mid": null,
   "far": null
  },
  "consumer": {
   "near": {
    "n": 145,
    "p50": 3,
    "p90": 68
   },
   "mid": null,
   "far": null
  },
  "insurer": {
   "near": {
    "n": 72,
    "p50": 4,
    "p90": 74
   },
   "mid": null,
   "far": null
  },
  "utility": {
   "near": {
    "n": 150,
    "p50": 4,
    "p90": 91
   },
   "mid": null,
   "far": null
  },
  "energy": {
   "near": {
    "n": 47,
    "p50": 2,
    "p90": 139
   },
   "mid": null,
   "far": null
  },
  "telecom": {
   "near": null,
   "mid": null,
   "far": null
  }
 }
};
  root.TRACK_RECORD = TRACK_DATA;
  if (typeof module !== 'undefined' && module.exports) module.exports = TRACK_DATA;
})(typeof window !== 'undefined' ? window : global);
