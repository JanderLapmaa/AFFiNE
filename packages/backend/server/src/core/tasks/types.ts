import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

@ObjectType('WorkspaceTaskRef')
export class WorkspaceTaskRefObjectType {
  @Field(() => Int, {
    description: 'UTF-16 offset of the reference placeholder in the text',
  })
  offset!: number;

  @Field({ description: 'Id of the linked doc' })
  docId!: string;
}

@ObjectType('WorkspaceTask')
export class WorkspaceTaskObjectType {
  @Field()
  docId!: string;

  @Field()
  blockId!: string;

  @Field({ description: 'Text of the todo; a linked doc is a space' })
  text!: string;

  @Field(() => [WorkspaceTaskRefObjectType], {
    description: 'Linked docs in the text, in text order',
  })
  refs!: WorkspaceTaskRefObjectType[];

  @Field(() => String, {
    nullable: true,
    description: 'Closest heading before the todo',
  })
  heading!: string | null;

  @Field(() => Int, { description: 'Position in the doc, in document order' })
  order!: number;

  @Field()
  checked!: boolean;

  @Field(() => String, { nullable: true, description: 'YYYY-MM-DD' })
  due!: string | null;

  @Field(() => Int, { nullable: true })
  priority!: number | null;

  @Field(() => Float, {
    nullable: true,
    description: 'Epoch milliseconds; only on a checked task',
  })
  completedAt!: number | null;
}

@ObjectType('WorkspaceTasks')
export class WorkspaceTasksObjectType {
  @Field({
    description:
      'Opaque. Changes when a task changes or when the docs the user can read change',
  })
  etag!: string;

  @Field({
    description:
      'False while the workspace is still being extracted; the list may be incomplete',
  })
  ready!: boolean;

  @Field(() => [WorkspaceTaskObjectType], {
    nullable: true,
    description: 'Null when knownEtag equals the current etag',
  })
  tasks!: WorkspaceTaskObjectType[] | null;
}
