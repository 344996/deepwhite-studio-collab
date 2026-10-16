/* Versioned, prompt-based asset operations. Workflow-backed tools are not registered here. */
window.StudioAssetPresets=Object.freeze([
  {id:'outfit',group:'person',name:'换服装',reference:'服装参考',version:1,
    instruction:'只改变人物的服装。保持图1人物的身份、脸型、五官、发型、体型、姿态、摄影机位置和背景。参考图2的服装时，只参考服装，不移植图2的人脸、身体或背景。服装与身体比例、遮挡和光线应合理。'},
  {id:'equipment',group:'person',name:'换装备',reference:'装备参考',version:1,
    instruction:'根据要求替换或添加人物装备。保持图1的人物身份、身体比例、姿态、未指定修改的服装和背景。若有图2，仅参考其中指定装备，保持合理的穿戴位置、接触关系、尺寸和光影。'},
  {id:'prop',group:'person',name:'换手持物',reference:'物品参考',version:1,
    instruction:'根据要求替换或添加人物手持物。保持图1人物身份、服装、背景及整体构图。若有图2，仅参考指定物品。手指、握持、物体尺寸与遮挡关系应合理，不增加多余手指或肢体。'},
  {id:'scene-angle',group:'scene',name:'改变场景视角',reference:'布局参考',version:1,
    instruction:'从新的摄影机位置重新表现图1的同一个场景。保持建筑结构、主要陈设、材质、时间与光线逻辑。改变的是观察位置和方向，不是把原图做平面旋转。图2如存在仅用作空间布局参考；图中未展示区域依据描述合理补全。'},
  {id:'scene-reverse',group:'scene',name:'反向镜头',reference:'布局参考',version:1,
    instruction:'以图1为同一场景的空间参考，生成反向观察的镜头：摄影机转到原观察方向的对侧并看回原摄影机方向。不是左右镜像，不是复制原构图。维持同一场景的建筑、材质、陈设与照明关系。不可见区域根据用户空间说明补全；有图2时按其布局约束。'},
  {id:'image-edit',group:'edit',name:'涂改与修改',reference:'替换参考',version:1,
    instruction:'按照用户要求编辑图1。保持未要求修改的内容、主体身份和整体构图。若提供红色涂抹标注图，红色区域仅表示希望修改的位置，成图必须去掉标记。标注图是位置说明，不是新的外观或配色参考。额外替换参考只用于用户指定对象。'}
]);
