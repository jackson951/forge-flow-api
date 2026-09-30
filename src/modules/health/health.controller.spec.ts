import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService],
    }).compile();
    controller = moduleRef.get(HealthController);
  });

  it('reports liveness', () => {
    expect(controller.live().status).toBe('ok');
  });
});
